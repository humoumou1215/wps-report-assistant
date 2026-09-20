package main

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// The journal shares state.json's atomic replacement with binding revisions.
// Host writes cannot participate in a database transaction. Prepared/undoing
// entries therefore remain durable and block new writes until reconciled.
type PPTChange struct {
	ID         string           `json:"id"`
	ProjectID  string           `json:"projectId"`
	DocumentID string           `json:"documentId"`
	Label      string           `json:"label"`
	CreatedAt  string           `json:"createdAt"`
	Entries    []PPTChangeEntry `json:"entries"`
}
type PPTChangeEntry struct {
	Target           map[string]any `json:"target"`
	Before           map[string]any `json:"before"`
	After            map[string]any `json:"after,omitempty"`
	Plan             map[string]any `json:"plan"`
	BeforeBinding    *Binding       `json:"beforeBinding"`
	AfterBinding     Binding        `json:"afterBinding"`
	VariableVersion  string         `json:"variableVersion"`
	Status           string         `json:"status"`
	Error            string         `json:"error,omitempty"`
	BindingCommitted bool           `json:"bindingCommitted"`
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}
func sameSnapshot(a, b map[string]any) bool {
	if a == nil || b == nil {
		return jsonEqual(a, b)
	}
	if a["comparison"] != nil || b["comparison"] != nil {
		return jsonEqual(a["comparison"], b["comparison"])
	}
	return jsonEqual(a, b)
}
func sameTarget(a, b map[string]any) bool {
	if a["capabilityId"] != nil || b["capabilityId"] != nil {
		return jsonEqual(a["capabilityId"], b["capabilityId"]) && jsonEqual(a["locator"], b["locator"])
	}
	return jsonEqual(a["slideId"], b["slideId"]) && jsonEqual(a["shapeId"], b["shapeId"])
}
func unresolved(c PPTChange) bool {
	for _, e := range c.Entries {
		if e.Status == "prepared" || e.Status == "undoing" {
			return true
		}
	}
	return false
}
func undoable(c PPTChange) bool {
	for _, e := range c.Entries {
		if e.Status == "applied" || e.Status == "prepared" || e.Status == "undoing" {
			return true
		}
	}
	return false
}
func bindingAt(p *Project, id string) *Binding {
	for i := range p.Bindings {
		if p.Bindings[i].ID == id {
			return &p.Bindings[i]
		}
	}
	return nil
}
func (s *Store) ListChanges(pid, doc string) ([]PPTChange, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.projectIndexLocked(pid) < 0 {
		return nil, appErr(404, "项目不存在")
	}
	out := []PPTChange{}
	for i := len(s.State.Changes) - 1; i >= 0; i-- {
		c := s.State.Changes[i]
		if c.ProjectID == pid && c.DocumentID == doc {
			out = append(out, cloneJSON(c))
		}
	}
	return out, nil
}
func (s *Store) PrepareChange(c PPTChange) (PPTChange, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(c.ProjectID)
	if pi < 0 {
		return c, appErr(404, "项目不存在")
	}
	p := &s.State.Projects[pi]
	foundDocument := false
	for _, d := range p.Documents {
		foundDocument = foundDocument || d.ID == c.DocumentID
	}
	if !foundDocument {
		return c, appErr(404, "目标文件不属于当前项目")
	}
	for _, old := range s.State.Changes {
		if old.ID == c.ID {
			if old.ProjectID == c.ProjectID && old.DocumentID == c.DocumentID {
				return cloneJSON(old), nil
			}
			return c, appErr(409, "操作编号重复")
		}
		if old.ProjectID == c.ProjectID && old.DocumentID == c.DocumentID && unresolved(old) {
			return c, appErr(409, "有未完成的修改，请先到修改历史中处理")
		}
	}
	if len(c.Entries) == 0 || len(c.Entries) > 200 {
		return c, appErr(400, "修改对象数必须为 1–200")
	}
	for i, e := range c.Entries {
		capability, _ := e.Target["capabilityId"].(string)
		kind, _ := e.Before["kind"].(string)
		adapterSnapshot := capability != "" && e.Before["adapterId"] == capability && kind != ""
		if e.Before == nil || e.Before["version"] != float64(1) || (!adapterSnapshot && kind != "text" && kind != "table") {
			return c, appErr(400, "缺少可恢复的对象快照")
		}
		if e.AfterBinding.DocumentID != c.DocumentID {
			return c, appErr(400, "目标文稿不一致")
		}
		slideID, _ := asFloat(e.Target["slideId"])
		shapeID, _ := asFloat(e.Target["shapeId"])
		locator, _ := e.Target["locator"].(map[string]any)
		if (slideID <= 0 || shapeID <= 0) && (capability == "" || len(locator) == 0) {
			return c, appErr(400, "目标缺少稳定标识")
		}
		for j := 0; j < i; j++ {
			if sameTarget(e.Target, c.Entries[j].Target) {
				return c, appErr(409, "同一批次不能重复修改同一个对象")
			}
		}
		current := bindingAt(p, e.AfterBinding.ID)
		if !jsonEqual(current, e.BeforeBinding) {
			return c, appErr(409, "绑定已变化，请重新生成")
		}
		valid := false
		for _, v := range p.Variables {
			if v.ID == e.AfterBinding.VariableID && v.UpdatedAt == e.VariableVersion {
				valid = true
			}
		}
		if !valid {
			return c, appErr(409, "变量已变化，请重新生成")
		}
		c.Entries[i].Status = "prepared"
		c.Entries[i].After = nil
		c.Entries[i].Error = ""
		c.Entries[i].BindingCommitted = false
	}
	c.CreatedAt = nowISO()
	s.State.Changes = append(s.State.Changes, cloneJSON(c))
	if err := s.saveLocked(); err != nil {
		s.State.Changes = s.State.Changes[:len(s.State.Changes)-1]
		return c, err
	}
	return cloneJSON(c), nil
}
func (s *Store) TransitionChange(pid, id string, index int, action string, snapshot map[string]any, message string) (PPTChange, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(pid)
	if pi < 0 {
		return PPTChange{}, appErr(404, "项目不存在")
	}
	ci := -1
	for i, c := range s.State.Changes {
		if c.ID == id && c.ProjectID == pid {
			ci = i
			break
		}
	}
	if ci < 0 {
		return PPTChange{}, appErr(404, "修改记录不存在")
	}
	c := &s.State.Changes[ci]
	if index < 0 || index >= len(c.Entries) {
		return PPTChange{}, appErr(400, "对象序号无效")
	}
	p := &s.State.Projects[pi]
	oldP := cloneJSON(*p)
	oldC := cloneJSON(*c)
	e := &c.Entries[index]
	if action == "undo-start" || action == "recover-start" || action == "undo-complete" {
		for i := len(s.State.Changes) - 1; i > ci; i-- {
			x := s.State.Changes[i]
			if x.ProjectID == pid && x.DocumentID == c.DocumentID && undoable(x) {
				return PPTChange{}, appErr(409, "请先撤销最近一次修改")
			}
		}
		for i := len(c.Entries) - 1; i > index; i-- {
			if c.Entries[i].Status != "undone" && c.Entries[i].Status != "failed" {
				return PPTChange{}, appErr(409, "请按对象修改顺序倒序撤销")
			}
		}
	}
	current := bindingAt(p, e.AfterBinding.ID)
	switch action {
	case "complete":
		for i := 0; i < index; i++ {
			if c.Entries[i].Status == "prepared" || c.Entries[i].Status == "undoing" {
				return PPTChange{}, appErr(409, "前一对象的执行尚未完成")
			}
		}
		if e.Status == "applied" && sameSnapshot(snapshot, e.After) {
			return cloneJSON(*c), nil
		}
		if e.Status != "prepared" || snapshot == nil || snapshot["version"] != float64(1) || snapshot["kind"] != e.Before["kind"] {
			return PPTChange{}, appErr(409, "修改状态不允许完成")
		}
		if !jsonEqual(current, e.BeforeBinding) {
			return PPTChange{}, appErr(409, "绑定已变化，需恢复中断操作")
		}
		if current == nil {
			p.Bindings = append(p.Bindings, cloneJSON(e.AfterBinding))
		} else {
			*current = cloneJSON(e.AfterBinding)
		}
		e.After = cloneJSON(snapshot)
		e.BindingCommitted = true
		e.Status = "applied"
	case "fail":
		if e.Status == "failed" {
			return cloneJSON(*c), nil
		}
		if e.Status != "prepared" || !sameSnapshot(snapshot, e.Before) {
			return PPTChange{}, appErr(409, "未验证恢复原状，不能标记失败")
		}
		e.Status = "failed"
		e.Error = message
	case "undo-start", "recover-start":
		if e.Status == "undoing" {
			return cloneJSON(*c), nil
		}
		if action == "undo-start" && (e.Status != "applied" || (!sameSnapshot(snapshot, e.After) && !sameSnapshot(snapshot, e.Before))) {
			return PPTChange{}, appErr(409, "对象已发生变化，不能自动撤销")
		}
		if action == "recover-start" && e.Status != "prepared" {
			return PPTChange{}, appErr(409, "该操作无需恢复")
		}
		if e.BeforeBinding != nil {
			found := false
			for _, v := range p.Variables {
				if v.ID == e.BeforeBinding.VariableID {
					found = true
				}
			}
			if !found {
				return PPTChange{}, appErr(409, "原绑定引用的变量已删除，无法恢复规则")
			}
		}
		if e.BindingCommitted && !jsonEqual(current, &e.AfterBinding) {
			return PPTChange{}, appErr(409, "绑定规则已变化，不能自动撤销")
		}
		if snapshot == nil {
			return PPTChange{}, appErr(400, "缺少当前状态")
		}
		// Recovery retains the observed partial state for inspection.
		if action == "recover-start" {
			e.After = cloneJSON(snapshot)
		}
		e.Status = "undoing"
	case "undo-complete":
		if e.Status == "undone" {
			return cloneJSON(*c), nil
		}
		if e.Status != "undoing" || !sameSnapshot(snapshot, e.Before) {
			return PPTChange{}, appErr(409, "尚未验证恢复结果")
		}
		if e.BindingCommitted {
			if !jsonEqual(current, &e.AfterBinding) {
				return PPTChange{}, appErr(409, "绑定已变化，恢复结果需检查")
			}
			if e.BeforeBinding != nil {
				*current = cloneJSON(*e.BeforeBinding)
			} else {
				for i, b := range p.Bindings {
					if b.ID == e.AfterBinding.ID {
						p.Bindings = append(p.Bindings[:i], p.Bindings[i+1:]...)
						break
					}
				}
			}
		}
		e.Status = "undone"
	default:
		return PPTChange{}, appErr(400, "未知修改操作")
	}
	p.UpdatedAt = nowISO()
	if err := s.saveLocked(); err != nil {
		*p = oldP
		*c = oldC
		return PPTChange{}, err
	}
	return cloneJSON(*c), nil
}
func (s *Server) changesAPI(w http.ResponseWriter, r *http.Request, pid string, sg []string) {
	if len(sg) == 4 && r.Method == "GET" {
		v, e := s.store.ListChanges(pid, r.URL.Query().Get("documentId"))
		if e != nil {
			s.fail(w, r, e)
			return
		}
		jsonOut(w, r, 200, map[string]any{"changes": v})
		return
	}
	b, e := readJSON(r)
	if e != nil {
		s.fail(w, r, e)
		return
	}
	if len(sg) == 4 && r.Method == "POST" {
		docID, _ := b["documentId"].(string)
		requestID, _ := b["requestId"].(string)
		label, _ := b["label"].(string)
		if requestID == "" {
			s.fail(w, r, appErr(400, "缺少操作编号"))
			return
		}
		// A lost prepare response is retried with the same request ID.
		old, _ := s.store.ListChanges(pid, docID)
		for _, c := range old {
			if c.ID == requestID {
				jsonOut(w, r, 200, map[string]any{"change": c})
				return
			}
		}
		project, err := s.store.GetProject(pid)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		var doc *Document
		for i := range project.Documents {
			if project.Documents[i].ID == docID {
				doc = &project.Documents[i]
			}
		}
		if doc == nil {
			s.fail(w, r, appErr(400, "目标文件 不属于当前项目"))
			return
		}
		c := PPTChange{ID: requestID, ProjectID: pid, DocumentID: docID, Label: label}
		inputs, _ := b["entries"].([]any)
		for _, raw := range inputs {
			in, ok := raw.(map[string]any)
			if !ok {
				s.fail(w, r, appErr(400, "修改条目无效"))
				return
			}
			before, _ := in["before"].(map[string]any)
			draftID, _ := in["draftId"].(string)
			bindingID, _ := in["bindingId"].(string)
			entry := PPTChangeEntry{Before: before}
			if draftID != "" {
				d, err := s.drafts.PeekBinding(pid, draftID)
				if err != nil {
					s.fail(w, r, err)
					return
				}
				approved, _ := in["approveDynamicCapability"].(bool)
				if d.DynamicCapability && !approved {
					s.fail(w, r, appErr(412, "请确认本次临时能力后再应用"))
					return
				}
				if d.DocumentID != docID {
					s.fail(w, r, appErr(409, "草稿不属于当前文稿"))
					return
				}
				entry.Plan = d.Plan
				entry.VariableVersion = d.VariableVersion
				entry.AfterBinding = Binding{ID: newID("bnd"), VariableID: d.VariableID, DocumentID: docID, DocumentKey: doc.Key, Description: d.Description, Target: d.Target, Renderer: d.Renderer, CreatedAt: nowISO(), UpdatedAt: nowISO()}
				if d.BindingID != "" {
					prev, err := s.store.BindingByID(pid, d.BindingID)
					if err != nil {
						s.fail(w, r, err)
						return
					}
					if prev.UpdatedAt != d.BindingVersion {
						s.fail(w, r, appErr(409, "绑定已修改，请重新生成"))
						return
					}
					entry.BeforeBinding = &prev
					entry.AfterBinding.ID = prev.ID
					entry.AfterBinding.CreatedAt = prev.CreatedAt
				}
			} else {
				prev, err := s.store.BindingByID(pid, bindingID)
				if err != nil {
					s.fail(w, r, err)
					return
				}
				entry.BeforeBinding = &prev
				entry.AfterBinding = prev
			}
			v, err := s.store.VariableByID(pid, entry.AfterBinding.VariableID)
			if err != nil {
				s.fail(w, r, err)
				return
			}
			if draftID != "" && entry.VariableVersion != v.UpdatedAt {
				s.fail(w, r, appErr(409, "变量已变化，请重新生成"))
				return
			}
			entry.VariableVersion = v.UpdatedAt
			if draftID == "" {
				entry.Plan, err = RenderPlan(v, entry.AfterBinding.Renderer)
				if err != nil {
					s.fail(w, r, err)
					return
				}
			}
			if !jsonEqual(entry.Plan, in["expectedPlan"]) {
				s.fail(w, r, appErr(409, "渲染结果已变化，请重新生成"))
				return
			}
			entry.Target = entry.AfterBinding.Target
			c.Entries = append(c.Entries, entry)
		}
		result, err := s.store.PrepareChange(c)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		for _, raw := range inputs {
			in, _ := raw.(map[string]any)
			if draftID, _ := in["draftId"].(string); draftID != "" {
				s.drafts.DiscardBinding(pid, draftID)
			}
		}
		jsonOut(w, r, 201, map[string]any{"change": result})
		return
	}
	if len(sg) == 7 && sg[5] == "entries" && r.Method == "POST" {
		index, err := strconv.Atoi(sg[6])
		if err != nil {
			s.fail(w, r, appErr(400, "对象序号无效"))
			return
		}
		action, _ := b["action"].(string)
		snap, _ := b["snapshot"].(map[string]any)
		msg, _ := b["error"].(string)
		result, err := s.store.TransitionChange(pid, sg[4], index, action, snap, msg)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		jsonOut(w, r, 200, map[string]any{"change": result})
		return
	}
	s.fail(w, r, appErr(404, "修改历史接口不存在"))
}

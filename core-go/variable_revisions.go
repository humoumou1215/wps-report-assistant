package main

import (
	"net/http"
	"strings"
)

type VariableRevision struct {
	ID         string   `json:"id"`
	ProjectID  string   `json:"projectId"`
	VariableID string   `json:"variableId"`
	CreatedAt  string   `json:"createdAt"`
	Variable   Variable `json:"variable"`
	Source     Source   `json:"source"`
}

func (s *Store) updateVariableDraftLocked(p *Project, d VariableDraft) (Source, Variable, error) {
	if !d.Validation.Passed {
		return Source{}, Variable{}, appErr(400, "变量方案未通过校验")
	}
	index := -1
	for i, v := range p.Variables {
		if v.ID == d.VariableID {
			index = i
		}
	}
	if index < 0 {
		return Source{}, Variable{}, appErr(404, "变量不存在")
	}
	old := p.Variables[index]
	if old.UpdatedAt != d.VariableVersion {
		return Source{}, Variable{}, appErr(409, "变量已变化，请重新生成")
	}
	var doc *Document
	for i := range p.Documents {
		if p.Documents[i].ID == d.DocumentID {
			doc = &p.Documents[i]
		}
	}
	if doc == nil {
		return Source{}, Variable{}, appErr(400, "数据源文件不属于当前项目")
	}
	name := strings.TrimSpace(d.Name)
	if name == "" {
		return Source{}, Variable{}, appErr(400, "变量名称不能为空")
	}
	for _, v := range p.Variables {
		if v.ID != old.ID && v.Name == name {
			return Source{}, Variable{}, appErr(409, "变量名称重复")
		}
	}
	var previousSource Source
	for _, src := range p.Sources {
		if src.ID == old.SourceID {
			previousSource = src
		}
	}
	before := cloneJSON(*p)
	revisionsBefore := len(s.State.VariableRevisions)
	revision := VariableRevision{ID: newID("rev"), ProjectID: p.ID, VariableID: old.ID, CreatedAt: nowISO(), Variable: old, Source: previousSource}
	src := Source{ID: newID("src"), DocumentID: doc.ID, DocumentKey: doc.Key, CapabilityID: d.CapabilityID, Locator: cloneJSON(d.Locator), SheetName: d.SheetName, Address: d.Address, Values: cloneJSON(d.Values), HeadersMode: d.HeadersMode, CreatedAt: nowISO(), UpdatedAt: nowISO()}
	v := old
	v.Name = name
	v.DisplayName = d.DisplayName
	if v.DisplayName == "" {
		v.DisplayName = name
	}
	v.Description = d.Description
	v.SourceID = src.ID
	v.Transform = cloneJSON(d.Transform)
	v.Value = cloneJSON(d.Result.Value)
	v.ValueType = d.Result.ValueType
	v.Columns = append([]string(nil), d.Result.Columns...)
	v.UpdatedAt = nowISO()
	v.LastError = nil
	p.Sources = append(p.Sources, src)
	p.Variables[index] = v
	p.UpdatedAt = nowISO()
	s.State.VariableRevisions = append(s.State.VariableRevisions, cloneJSON(revision))
	if err := s.saveLocked(); err != nil {
		*p = before
		s.State.VariableRevisions = s.State.VariableRevisions[:revisionsBefore]
		return Source{}, Variable{}, err
	}
	return cloneJSON(src), cloneJSON(v), nil
}
func (s *Store) variableRevisions(pid, vid string) ([]VariableRevision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(pid)
	if pi < 0 {
		return nil, appErr(404, "项目不存在")
	}
	found := false
	for _, v := range s.State.Projects[pi].Variables {
		found = found || v.ID == vid
	}
	if !found {
		return nil, appErr(404, "变量不存在")
	}
	out := []VariableRevision{}
	for i := len(s.State.VariableRevisions) - 1; i >= 0; i-- {
		r := s.State.VariableRevisions[i]
		if r.ProjectID == pid && r.VariableID == vid {
			out = append(out, cloneJSON(r))
		}
	}
	return out, nil
}
func (s *Store) restoreVariableRevision(pid, vid, rid, expected string) (Variable, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(pid)
	if pi < 0 {
		return Variable{}, appErr(404, "项目不存在")
	}
	p := &s.State.Projects[pi]
	vi := -1
	for i, v := range p.Variables {
		if v.ID == vid {
			vi = i
		}
	}
	if vi < 0 {
		return Variable{}, appErr(404, "变量不存在")
	}
	if p.Variables[vi].UpdatedAt != expected {
		return Variable{}, appErr(409, "变量已变化，请重新打开详情")
	}
	var rev *VariableRevision
	for i := range s.State.VariableRevisions {
		r := &s.State.VariableRevisions[i]
		if r.ID == rid && r.ProjectID == pid && r.VariableID == vid {
			rev = r
		}
	}
	if rev == nil {
		return Variable{}, appErr(404, "版本不存在")
	}
	for _, v := range p.Variables {
		if v.ID != vid && v.Name == rev.Variable.Name {
			return Variable{}, appErr(409, "历史名称已被其他变量使用，请先修改重名变量")
		}
	}
	old := cloneJSON(*p)
	oldLen := len(s.State.VariableRevisions)
	current := p.Variables[vi]
	var source Source
	for _, src := range p.Sources {
		if src.ID == current.SourceID {
			source = src
		}
	}
	restored := cloneJSON(rev.Variable)
	restored.UpdatedAt = nowISO()
	savedSource := cloneJSON(rev.Source)
	savedSource.ID = newID("src")
	savedSource.UpdatedAt = nowISO()
	restored.SourceID = savedSource.ID
	s.State.VariableRevisions = append(s.State.VariableRevisions, VariableRevision{ID: newID("rev"), ProjectID: pid, VariableID: vid, CreatedAt: nowISO(), Variable: current, Source: source})
	p.Sources = append(p.Sources, savedSource)
	p.Variables[vi] = restored
	p.UpdatedAt = nowISO()
	if err := s.saveLocked(); err != nil {
		*p = old
		s.State.VariableRevisions = s.State.VariableRevisions[:oldLen]
		return Variable{}, err
	}
	return cloneJSON(restored), nil
}
func (s *Server) variableRevisionsAPI(w http.ResponseWriter, r *http.Request, pid, vid string) {
	if r.Method == "GET" {
		out, err := s.store.variableRevisions(pid, vid)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		jsonOut(w, r, 200, map[string]any{"revisions": out})
		return
	}
	if r.Method == "POST" {
		b, err := readJSON(r)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		id, _ := b["revisionId"].(string)
		version, _ := b["expectedVersion"].(string)
		v, err := s.store.restoreVariableRevision(pid, vid, id, version)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		jsonOut(w, r, 200, map[string]any{"variable": v})
		return
	}
	s.fail(w, r, appErr(405, "不支持的操作"))
}

// Caller holds the store lock; the caller's save transaction also persists this revision.
func (s *Store) recordVariableRevisionLocked(p *Project, v Variable) {
	var source Source
	for _, src := range p.Sources {
		if src.ID == v.SourceID {
			source = src
			break
		}
	}
	s.State.VariableRevisions = append(s.State.VariableRevisions, cloneJSON(VariableRevision{ID: newID("rev"), ProjectID: p.ID, VariableID: v.ID, CreatedAt: nowISO(), Variable: v, Source: source}))
}

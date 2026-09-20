package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type AppError struct {
	Status int
	Msg    string
}

func (e *AppError) Error() string         { return e.Msg }
func appErr(status int, msg string) error { return &AppError{Status: status, Msg: msg} }

func nowISO() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func newID(prefix string) string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(b)
}
func normalizeDocKey(v string) string {
	v = strings.ReplaceAll(strings.TrimSpace(v), `\`, `/`)
	// Windows paths are case-insensitive; POSIX paths may reside on a
	// case-sensitive volume, including macOS. Keep their identity intact.
	if (len(v) >= 2 && v[1] == ':') || strings.HasPrefix(v, "//") {
		return strings.ToLower(v)
	}
	return v
}

type Document struct {
	Capabilities []string `json:"capabilities,omitempty"`
	ID           string   `json:"id"`
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	CreatedAt    string   `json:"createdAt"`
	LastSeenAt   string   `json:"lastSeenAt"`
}
type Source struct {
	CapabilityID string         `json:"capabilityId,omitempty"`
	Locator      map[string]any `json:"locator,omitempty"`
	ID           string         `json:"id"`
	DocumentID   string         `json:"documentId"`
	DocumentKey  string         `json:"documentKey"`
	SheetName    string         `json:"sheetName"`
	Address      string         `json:"address"`
	Values       any            `json:"values"`
	HeadersMode  string         `json:"headersMode"`
	CreatedAt    string         `json:"createdAt"`
	UpdatedAt    string         `json:"updatedAt"`
}
type Variable struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	DisplayName string         `json:"displayName"`
	SourceID    string         `json:"sourceId"`
	Description string         `json:"description"`
	Transform   map[string]any `json:"transform"`
	Value       any            `json:"value"`
	ValueType   string         `json:"valueType"`
	Columns     []string       `json:"columns"`
	CreatedAt   string         `json:"createdAt"`
	UpdatedAt   string         `json:"updatedAt"`
	LastError   any            `json:"lastError"`
}
type Binding struct {
	ID          string         `json:"id"`
	VariableID  string         `json:"variableId"`
	DocumentID  string         `json:"documentId"`
	DocumentKey string         `json:"documentKey"`
	Description string         `json:"description"`
	Target      map[string]any `json:"target"`
	Renderer    map[string]any `json:"renderer"`
	CreatedAt   string         `json:"createdAt"`
	UpdatedAt   string         `json:"updatedAt"`
}
type Project struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	CreatedAt string     `json:"createdAt"`
	UpdatedAt string     `json:"updatedAt"`
	Documents []Document `json:"documents"`
	Sources   []Source   `json:"sources"`
	Variables []Variable `json:"variables"`
	Bindings  []Binding  `json:"bindings"`
}
type State struct {
	VariableRevisions []VariableRevision `json:"variableRevisions,omitempty"`
	Changes           []PPTChange        `json:"pptChanges,omitempty"`
	Version           int                `json:"version"`
	Projects          []Project          `json:"projects"`
}
type AISettings struct {
	Enabled     bool    `json:"enabled"`
	BaseURL     string  `json:"baseUrl"`
	APIKey      string  `json:"apiKey"`
	Model       string  `json:"model"`
	Temperature float64 `json:"temperature"`
}
type DebugSettings struct {
	Enabled           bool `json:"enabled"`
	IncludeSourceData bool `json:"includeSourceData"`
	MaxEvents         int  `json:"maxEvents"`
}
type AgentSettings struct {
	CriticEnabled              bool `json:"criticEnabled"`
	DynamicCapabilitiesEnabled bool `json:"dynamicCapabilitiesEnabled"`
}
type Settings struct {
	AI      AISettings      `json:"ai"`
	Debug   DebugSettings   `json:"debug"`
	Agent   AgentSettings   `json:"agent"`
	Context context.Context `json:"-"`
}

type Store struct {
	mu                               sync.Mutex
	dataDir, stateFile, settingsFile string
	State                            State
	Settings                         Settings
}

func defaultSettings() Settings {
	return Settings{
		AI:    AISettings{Enabled: false, BaseURL: "https://api.openai.com/v1", APIKey: "", Model: "gpt-5.6", Temperature: 0.1},
		Debug: DebugSettings{Enabled: false, IncludeSourceData: false, MaxEvents: 2000},
		Agent: AgentSettings{CriticEnabled: true, DynamicCapabilitiesEnabled: false},
	}
}
func NewStore(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, err
	}
	s := &Store{dataDir: dataDir, stateFile: filepath.Join(dataDir, "state.json"), settingsFile: filepath.Join(dataDir, "settings.json"), State: State{Version: 1, Projects: []Project{}}, Settings: defaultSettings()}
	if err := loadJSON(s.stateFile, &s.State); err != nil && !errors.Is(err, os.ErrNotExist) {
		preserveCorruptFile(s.stateFile)
		return nil, fmt.Errorf("读取状态文件失败（已保留原文件）：%w", err)
	}
	if err := loadJSON(s.settingsFile, &s.Settings); err != nil && !errors.Is(err, os.ErrNotExist) {
		preserveCorruptFile(s.settingsFile)
		return nil, fmt.Errorf("读取设置文件失败（已保留原文件）：%w", err)
	}
	if s.State.Version == 0 {
		s.State.Version = 1
	}
	if s.State.Projects == nil {
		s.State.Projects = []Project{}
	}
	if s.Settings.AI.BaseURL == "" {
		s.Settings.AI = defaultSettings().AI
	}
	if s.Settings.Debug.MaxEvents <= 0 {
		s.Settings.Debug.MaxEvents = 2000
	}
	// Renderer migration: normalize legacy AI wrapper shapes and recover/repair
	// deterministic unit-conversion semantics from the binding description.
	migrated := false
	for pi := range s.State.Projects {
		for bi := range s.State.Projects[pi].Bindings {
			b := &s.State.Projects[pi].Bindings[bi]
			if norm, err := NormalizeRendererSpec(b.Renderer); err == nil {
				norm = ApplyBindingDescriptionHints(norm, b.Description)
				before, _ := json.Marshal(b.Renderer)
				after, _ := json.Marshal(norm)
				if string(before) != string(after) {
					b.Renderer = norm
					b.UpdatedAt = nowISO()
					migrated = true
				}
			}
		}
	}
	if migrated {
		_ = s.saveLocked()
	}
	return s, nil
}
func loadJSON(file string, dst any) error {
	b, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, dst)
}
func preserveCorruptFile(file string) {
	b, err := os.ReadFile(file)
	if err != nil {
		return
	}
	backup := fmt.Sprintf("%s.corrupt-%d", file, time.Now().UnixNano())
	_ = os.WriteFile(backup, b, 0600)
}
func saveJSON(file string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err = os.WriteFile(tmp, b, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}
func (s *Store) saveLocked() error         { return saveJSON(s.stateFile, &s.State) }
func (s *Store) saveSettingsLocked() error { return saveJSON(s.settingsFile, &s.Settings) }
func cloneJSON[T any](v T) T {
	var out T
	b, _ := json.Marshal(v)
	_ = json.Unmarshal(b, &out)
	return out
}

func (s *Store) ListProjects() []Project {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneJSON(s.State.Projects)
}

type ProjectSummary struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	UpdatedAt     string `json:"updatedAt"`
	DocumentCount int    `json:"documentCount"`
	VariableCount int    `json:"variableCount"`
	BindingCount  int    `json:"bindingCount"`
}

func (s *Store) ListProjectSummaries() []ProjectSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]ProjectSummary, 0, len(s.State.Projects))
	for _, p := range s.State.Projects {
		out = append(out, ProjectSummary{ID: p.ID, Name: p.Name, UpdatedAt: p.UpdatedAt, DocumentCount: len(p.Documents), VariableCount: len(p.Variables), BindingCount: len(p.Bindings)})
	}
	return out
}
func (s *Store) projectIndexLocked(id string) int {
	for i := range s.State.Projects {
		if s.State.Projects[i].ID == id {
			return i
		}
	}
	return -1
}
func (s *Store) GetProject(id string) (Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.projectIndexLocked(id)
	if i < 0 {
		return Project{}, appErr(404, "项目不存在")
	}
	return cloneJSON(s.State.Projects[i]), nil
}
func (s *Store) CreateProject(name string) (Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	name = strings.TrimSpace(name)
	if name == "" {
		return Project{}, appErr(400, "项目名称不能为空")
	}
	p := Project{ID: newID("prj"), Name: name, CreatedAt: nowISO(), UpdatedAt: nowISO(), Documents: []Document{}, Sources: []Source{}, Variables: []Variable{}, Bindings: []Binding{}}
	oldLen := len(s.State.Projects)
	s.State.Projects = append(s.State.Projects, p)
	if err := s.saveLocked(); err != nil {
		s.State.Projects = s.State.Projects[:oldLen]
		return Project{}, err
	}
	return cloneJSON(p), nil
}
func (s *Store) UpdateProject(id string, patch map[string]any) (Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.projectIndexLocked(id)
	if i < 0 {
		return Project{}, appErr(404, "项目不存在")
	}
	old := cloneJSON(s.State.Projects[i])
	if n, ok := patch["name"].(string); ok && strings.TrimSpace(n) != "" {
		s.State.Projects[i].Name = strings.TrimSpace(n)
	}
	s.State.Projects[i].UpdatedAt = nowISO()
	if err := s.saveLocked(); err != nil {
		s.State.Projects[i] = old
		return Project{}, err
	}
	return cloneJSON(s.State.Projects[i]), nil
}
func (s *Store) DeleteProject(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.projectIndexLocked(id)
	if i < 0 {
		return appErr(404, "项目不存在")
	}
	old := cloneJSON(s.State.Projects)
	oldChanges := cloneJSON(s.State.Changes)
	oldRevisions := cloneJSON(s.State.VariableRevisions)
	s.State.Projects = append(s.State.Projects[:i], s.State.Projects[i+1:]...)
	keptChanges := []PPTChange{}
	for _, change := range s.State.Changes {
		if change.ProjectID != id {
			keptChanges = append(keptChanges, change)
		}
	}
	s.State.Changes = keptChanges
	keptRevisions := []VariableRevision{}
	for _, revision := range s.State.VariableRevisions {
		if revision.ProjectID != id {
			keptRevisions = append(keptRevisions, revision)
		}
	}
	s.State.VariableRevisions = keptRevisions
	if err := s.saveLocked(); err != nil {
		s.State.Projects = old
		s.State.Changes = oldChanges
		s.State.VariableRevisions = oldRevisions
		return err
	}
	return nil
}
func (s *Store) resolveProjectLocked(key string) (int, int) {
	nk := normalizeDocKey(key)
	if nk == "" {
		return -1, -1
	}
	for pi := range s.State.Projects {
		for di := range s.State.Projects[pi].Documents {
			if normalizeDocKey(s.State.Projects[pi].Documents[di].Key) == nk {
				return pi, di
			}
		}
	}
	return -1, -1
}
func (s *Store) ResolveProject(key string) (*Project, *Document) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi, di := s.resolveProjectLocked(key)
	if pi < 0 {
		return nil, nil
	}
	p := cloneJSON(s.State.Projects[pi])
	d := cloneJSON(s.State.Projects[pi].Documents[di])
	return &p, &d
}
func baseName(k string) string {
	k = strings.ReplaceAll(k, `\`, `/`)
	if i := strings.LastIndex(k, "/"); i >= 0 {
		return k[i+1:]
	}
	return k
}
func (s *Store) RegisterDocument(projectID string, in map[string]any) (Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(projectID)
	if pi < 0 {
		return Document{}, appErr(404, "项目不存在")
	}
	key, _ := in["key"].(string)
	kind, _ := in["kind"].(string)
	name, _ := in["name"].(string)
	key = strings.TrimSpace(key)
	kind = strings.ToLower(kind)
	if key == "" || !regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`).MatchString(kind) {
		return Document{}, appErr(400, "文档 key/kind 无效")
	}
	cpi, _ := s.resolveProjectLocked(key)
	if cpi >= 0 && cpi != pi {
		return Document{}, appErr(409, fmt.Sprintf("该文件已属于项目“%s”", s.State.Projects[cpi].Name))
	}
	p := &s.State.Projects[pi]
	for i := range p.Documents {
		if normalizeDocKey(p.Documents[i].Key) == normalizeDocKey(key) {
			old := cloneJSON(p.Documents[i])
			oldUpdated := p.UpdatedAt
			p.Documents[i].LastSeenAt = nowISO()
			if name != "" {
				p.Documents[i].Name = name
			}
			p.Documents[i].Kind = kind
			if in["capabilities"] != nil {
				p.Documents[i].Capabilities = toStringSlice(in["capabilities"])
			}
			p.UpdatedAt = nowISO()
			if err := s.saveLocked(); err != nil {
				p.Documents[i] = old
				p.UpdatedAt = oldUpdated
				return Document{}, err
			}
			return cloneJSON(p.Documents[i]), nil
		}
	}
	if name == "" {
		name = baseName(key)
	}
	d := Document{Capabilities: toStringSlice(in["capabilities"]), ID: newID("doc"), Key: key, Name: name, Kind: kind, CreatedAt: nowISO(), LastSeenAt: nowISO()}
	p.Documents = append(p.Documents, d)
	p.UpdatedAt = nowISO()
	if err := s.saveLocked(); err != nil {
		p.Documents = p.Documents[:len(p.Documents)-1]
		return Document{}, err
	}
	return cloneJSON(d), nil
}
func (s *Store) AddSource(projectID string, in map[string]any) (Source, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(projectID)
	if pi < 0 {
		return Source{}, appErr(404, "项目不存在")
	}
	docID, _ := in["documentId"].(string)
	p := &s.State.Projects[pi]
	var d *Document
	for i := range p.Documents {
		if p.Documents[i].ID == docID {
			d = &p.Documents[i]
			break
		}
	}
	if d == nil {
		return Source{}, appErr(400, "数据源文件必须属于当前项目")
	}
	sheet, _ := in["sheetName"].(string)
	addr, _ := in["address"].(string)
	hm, _ := in["headersMode"].(string)
	if hm == "" {
		hm = "first-row"
	}
	capabilityID, _ := in["capabilityId"].(string)
	locator, _ := in["locator"].(map[string]any)
	src := Source{CapabilityID: capabilityID, Locator: locator, ID: newID("src"), DocumentID: d.ID, DocumentKey: d.Key, SheetName: sheet, Address: addr, Values: in["values"], HeadersMode: hm, CreatedAt: nowISO(), UpdatedAt: nowISO()}
	p.Sources = append(p.Sources, src)
	p.UpdatedAt = nowISO()
	if err := s.saveLocked(); err != nil {
		p.Sources = p.Sources[:len(p.Sources)-1]
		return Source{}, err
	}
	return cloneJSON(src), nil
}
func (s *Store) UpdateSource(projectID, sourceID string, values any) (Source, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(projectID)
	if pi < 0 {
		return Source{}, appErr(404, "项目不存在")
	}
	p := &s.State.Projects[pi]
	var computed = map[string]TransformResult{}
	for _, v := range p.Variables {
		if v.SourceID != sourceID {
			continue
		}
		validation := ValidateTransformContract(values, v.Transform)
		if !validation.Passed {
			return Source{}, appErr(422, "源数据不再满足变量“"+v.DisplayName+"”的字段契约："+strings.Join(validation.Errors, "；"))
		}
		result, err := ExecuteTransform(values, v.Transform)
		if err != nil {
			return Source{}, appErr(422, "变量“"+v.DisplayName+"”重算失败："+err.Error())
		}
		computed[v.ID] = result
	}
	for i := range p.Sources {
		if p.Sources[i].ID == sourceID {
			oldSource := cloneJSON(p.Sources[i])
			oldVariables := cloneJSON(p.Variables)
			oldProjectUpdated := p.UpdatedAt
			oldRevisionCount := len(s.State.VariableRevisions)
			p.Sources[i].Values = values
			p.Sources[i].UpdatedAt = nowISO()
			for vi := range p.Variables {
				if result, ok := computed[p.Variables[vi].ID]; ok {
					s.State.VariableRevisions = append(s.State.VariableRevisions, VariableRevision{ID: newID("rev"), ProjectID: projectID, VariableID: p.Variables[vi].ID, CreatedAt: nowISO(), Variable: cloneJSON(p.Variables[vi]), Source: oldSource})
					p.Variables[vi].Value = result.Value
					p.Variables[vi].ValueType = result.ValueType
					p.Variables[vi].Columns = result.Columns
					p.Variables[vi].LastError = nil
					p.Variables[vi].UpdatedAt = nowISO()
				}
			}
			p.UpdatedAt = nowISO()
			if err := s.saveLocked(); err != nil {
				p.Sources[i] = oldSource
				p.Variables = oldVariables
				p.UpdatedAt = oldProjectUpdated
				s.State.VariableRevisions = s.State.VariableRevisions[:oldRevisionCount]
				return Source{}, err
			}
			return cloneJSON(p.Sources[i]), nil
		}
	}
	return Source{}, appErr(404, "数据源不存在")
}

func (s *Store) RefreshVariable(projectID, varID string, values any) (Variable, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(projectID)
	if pi < 0 {
		return Variable{}, appErr(404, "项目不存在")
	}
	p := &s.State.Projects[pi]
	for vi := range p.Variables {
		if p.Variables[vi].ID != varID {
			continue
		}
		validation := ValidateTransformContract(values, p.Variables[vi].Transform)
		if !validation.Passed {
			return Variable{}, appErr(422, "源数据不再满足变量字段契约："+strings.Join(validation.Errors, "；"))
		}
		result, err := ExecuteTransform(values, p.Variables[vi].Transform)
		if err != nil {
			return Variable{}, appErr(422, "变量重算失败："+err.Error())
		}
		old := cloneJSON(p.Variables[vi])
		oldUpdated := p.UpdatedAt
		oldRevisionCount := len(s.State.VariableRevisions)
		s.recordVariableRevisionLocked(p, old)
		p.Variables[vi].Value = result.Value
		p.Variables[vi].ValueType = result.ValueType
		p.Variables[vi].Columns = result.Columns
		p.Variables[vi].LastError = nil
		p.Variables[vi].UpdatedAt = nowISO()
		p.UpdatedAt = nowISO()
		if err := s.saveLocked(); err != nil {
			p.Variables[vi] = old
			p.UpdatedAt = oldUpdated
			s.State.VariableRevisions = s.State.VariableRevisions[:oldRevisionCount]
			return Variable{}, err
		}
		return cloneJSON(p.Variables[vi]), nil
	}
	return Variable{}, appErr(404, "变量不存在")
}
func (s *Store) AddVariable(projectID string, in map[string]any) (Variable, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(projectID)
	if pi < 0 {
		return Variable{}, appErr(404, "项目不存在")
	}
	p := &s.State.Projects[pi]
	sourceID, _ := in["sourceId"].(string)
	found := false
	for i := range p.Sources {
		if p.Sources[i].ID == sourceID {
			found = true
			break
		}
	}
	if !found {
		return Variable{}, appErr(400, "变量数据源不属于当前项目")
	}
	name, _ := in["name"].(string)
	name = strings.TrimSpace(name)
	if name == "" {
		return Variable{}, appErr(400, "变量名称不能为空")
	}
	for _, v := range p.Variables {
		if v.Name == name {
			return Variable{}, appErr(409, "当前项目内变量名称重复")
		}
	}
	display, _ := in["displayName"].(string)
	if display == "" {
		display = name
	}
	desc, _ := in["description"].(string)
	vt, _ := in["valueType"].(string)
	if vt == "" {
		vt = "table"
	}
	cols := toStringSlice(in["columns"])
	tr, _ := in["transform"].(map[string]any)
	v := Variable{ID: newID("var"), Name: name, DisplayName: display, SourceID: sourceID, Description: desc, Transform: tr, Value: in["value"], ValueType: vt, Columns: cols, CreatedAt: nowISO(), UpdatedAt: nowISO(), LastError: nil}
	p.Variables = append(p.Variables, v)
	p.UpdatedAt = nowISO()
	if err := s.saveLocked(); err != nil {
		p.Variables = p.Variables[:len(p.Variables)-1]
		return Variable{}, err
	}
	return cloneJSON(v), nil
}
func (s *Store) UpdateVariableResult(projectID, varID string, result TransformResult) (Variable, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(projectID)
	if pi < 0 {
		return Variable{}, appErr(404, "项目不存在")
	}
	p := &s.State.Projects[pi]
	for i := range p.Variables {
		if p.Variables[i].ID == varID {
			old := cloneJSON(p.Variables[i])
			oldUpdated := p.UpdatedAt
			oldRevisionCount := len(s.State.VariableRevisions)
			s.recordVariableRevisionLocked(p, old)
			p.Variables[i].Value = result.Value
			p.Variables[i].ValueType = result.ValueType
			p.Variables[i].Columns = result.Columns
			p.Variables[i].LastError = nil
			p.Variables[i].UpdatedAt = nowISO()
			p.UpdatedAt = nowISO()
			if err := s.saveLocked(); err != nil {
				p.Variables[i] = old
				p.UpdatedAt = oldUpdated
				s.State.VariableRevisions = s.State.VariableRevisions[:oldRevisionCount]
				return Variable{}, err
			}
			return cloneJSON(p.Variables[i]), nil
		}
	}
	return Variable{}, appErr(404, "变量不存在")
}
func (s *Store) DeleteVariable(projectID, varID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(projectID)
	if pi < 0 {
		return appErr(404, "项目不存在")
	}
	p := &s.State.Projects[pi]
	for _, b := range p.Bindings {
		if b.VariableID == varID {
			return appErr(409, "变量仍被输出引用，请先删除输出绑定")
		}
	}
	oldVariables, oldUpdated := cloneJSON(p.Variables), p.UpdatedAt
	out := p.Variables[:0]
	found := false
	for _, v := range p.Variables {
		if v.ID == varID {
			found = true
			continue
		}
		out = append(out, v)
	}
	if !found {
		return appErr(404, "变量不存在")
	}
	p.Variables = out
	p.UpdatedAt = nowISO()
	if err := s.saveLocked(); err != nil {
		p.Variables = oldVariables
		p.UpdatedAt = oldUpdated
		return err
	}
	return nil
}
func (s *Store) AddBinding(projectID string, in map[string]any) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(projectID)
	if pi < 0 {
		return Binding{}, appErr(404, "项目不存在")
	}
	p := &s.State.Projects[pi]
	varID, _ := in["variableId"].(string)
	docID, _ := in["documentId"].(string)
	vf := false
	for _, v := range p.Variables {
		if v.ID == varID {
			vf = true
			break
		}
	}
	if !vf {
		return Binding{}, appErr(400, "绑定变量不属于当前项目")
	}
	var d *Document
	for i := range p.Documents {
		if p.Documents[i].ID == docID {
			d = &p.Documents[i]
			break
		}
	}
	if d == nil {
		return Binding{}, appErr(400, "目标文件不属于当前项目")
	}
	desc, _ := in["description"].(string)
	target, _ := in["target"].(map[string]any)
	renderer, _ := in["renderer"].(map[string]any)
	b := Binding{ID: newID("bnd"), VariableID: varID, DocumentID: docID, DocumentKey: d.Key, Description: desc, Target: target, Renderer: renderer, CreatedAt: nowISO(), UpdatedAt: nowISO()}
	oldLen := len(p.Bindings)
	oldUpdated := p.UpdatedAt
	p.Bindings = append(p.Bindings, b)
	p.UpdatedAt = nowISO()
	if err := s.saveLocked(); err != nil {
		p.Bindings = p.Bindings[:oldLen]
		p.UpdatedAt = oldUpdated
		return Binding{}, err
	}
	return cloneJSON(b), nil
}
func (s *Store) DeleteBinding(projectID, bindingID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(projectID)
	if pi < 0 {
		return appErr(404, "项目不存在")
	}
	for _, change := range s.State.Changes {
		if change.ProjectID == projectID && undoable(change) {
			for _, entry := range change.Entries {
				if entry.AfterBinding.ID == bindingID && (entry.Status == "applied" || entry.Status == "prepared" || entry.Status == "undoing") {
					return appErr(409, "该绑定仍有可撤销修改，请先在修改历史中撤销后再删除")
				}
			}
		}
	}

	p := &s.State.Projects[pi]
	oldBindings, oldUpdated := cloneJSON(p.Bindings), p.UpdatedAt
	out := p.Bindings[:0]
	found := false
	for _, b := range p.Bindings {
		if b.ID == bindingID {
			found = true
			continue
		}
		out = append(out, b)
	}
	if !found {
		return appErr(404, "绑定不存在")
	}
	p.Bindings = out
	p.UpdatedAt = nowISO()
	if err := s.saveLocked(); err != nil {
		p.Bindings = oldBindings
		p.UpdatedAt = oldUpdated
		return err
	}
	return nil
}
func (s *Store) GetSettings() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneJSON(s.Settings)
}
func (s *Store) UpdateAI(in map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := cloneJSON(s.Settings.AI)
	if v, ok := in["enabled"].(bool); ok {
		s.Settings.AI.Enabled = v
	}
	if v, ok := in["baseUrl"].(string); ok {
		s.Settings.AI.BaseURL = v
	}
	if v, ok := in["model"].(string); ok {
		s.Settings.AI.Model = v
	}
	if v, ok := in["apiKey"].(string); ok && v != "••••••••" {
		s.Settings.AI.APIKey = v
	}
	if v, ok := asFloat(in["temperature"]); ok {
		s.Settings.AI.Temperature = v
	}
	if err := s.saveSettingsLocked(); err != nil {
		s.Settings.AI = old
		return err
	}
	return nil
}
func (s *Store) UpdateDebug(in map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := cloneJSON(s.Settings.Debug)
	if v, ok := in["enabled"].(bool); ok {
		s.Settings.Debug.Enabled = v
	}
	if v, ok := in["includeSourceData"].(bool); ok {
		s.Settings.Debug.IncludeSourceData = v
	}
	if v, ok := asFloat(in["maxEvents"]); ok {
		n := int(v)
		if n < 100 {
			n = 100
		}
		if n > 5000 {
			n = 5000
		}
		s.Settings.Debug.MaxEvents = n
	}
	if err := s.saveSettingsLocked(); err != nil {
		s.Settings.Debug = old
		return err
	}
	return nil
}
func (s *Store) UpdateAgent(in map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := cloneJSON(s.Settings.Agent)
	if v, ok := in["criticEnabled"].(bool); ok {
		s.Settings.Agent.CriticEnabled = v
	}
	if v, ok := in["dynamicCapabilitiesEnabled"].(bool); ok {
		s.Settings.Agent.DynamicCapabilitiesEnabled = v
	}
	if err := s.saveSettingsLocked(); err != nil {
		s.Settings.Agent = old
		return err
	}
	return nil
}
func (s *Store) SnapshotProject(id string) (Project, error) { return s.GetProject(id) }
func (s *Store) SourceByID(projectID, sourceID string) (Source, error) {
	p, err := s.GetProject(projectID)
	if err != nil {
		return Source{}, err
	}
	for _, x := range p.Sources {
		if x.ID == sourceID {
			return x, nil
		}
	}
	return Source{}, appErr(404, "数据源不存在")
}
func (s *Store) VariableByID(projectID, varID string) (Variable, error) {
	p, err := s.GetProject(projectID)
	if err != nil {
		return Variable{}, err
	}
	for _, x := range p.Variables {
		if x.ID == varID {
			return x, nil
		}
	}
	return Variable{}, appErr(404, "变量不存在")
}
func (s *Store) BindingByID(projectID, bID string) (Binding, error) {
	p, err := s.GetProject(projectID)
	if err != nil {
		return Binding{}, err
	}
	for _, x := range p.Bindings {
		if x.ID == bID {
			return x, nil
		}
	}
	return Binding{}, appErr(404, "绑定不存在")
}
func toStringSlice(v any) []string {
	var out []string
	switch x := v.(type) {
	case []string:
		return append([]string(nil), x...)
	case []any:
		for _, e := range x {
			out = append(out, fmt.Sprint(e))
		}
	}
	return out
}
func asFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

var _ = errors.New

// CommitVariableDraft persists source + variable in one store lock/save. Previewing
// never mutates project state, and confirmation cannot leave an orphan source when
// variable validation fails.
func (s *Store) CommitVariableDraft(projectID string, d VariableDraft) (Source, Variable, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pi := s.projectIndexLocked(projectID)
	if pi < 0 {
		return Source{}, Variable{}, appErr(404, "项目不存在")
	}
	p := &s.State.Projects[pi]
	if d.VariableID != "" {
		return s.updateVariableDraftLocked(p, d)
	}
	var doc *Document
	for i := range p.Documents {
		if p.Documents[i].ID == d.DocumentID {
			doc = &p.Documents[i]
			break
		}
	}
	if doc == nil {
		return Source{}, Variable{}, appErr(400, "数据源文件必须属于当前项目")
	}
	name := strings.TrimSpace(d.Name)
	if name == "" {
		return Source{}, Variable{}, appErr(400, "变量名称不能为空")
	}
	for _, x := range p.Variables {
		if x.Name == name {
			return Source{}, Variable{}, appErr(409, "当前项目内变量名称重复")
		}
	}
	if !d.Validation.Passed {
		return Source{}, Variable{}, appErr(400, "不能保存未通过校验的变量预览")
	}
	display := strings.TrimSpace(d.DisplayName)
	if display == "" {
		display = name
	}
	hm := d.HeadersMode
	if hm == "" {
		hm = "first-row"
	}
	now := nowISO()
	src := Source{
		ID: newID("src"), DocumentID: doc.ID, DocumentKey: doc.Key,
		CapabilityID: d.CapabilityID, Locator: d.Locator, SheetName: d.SheetName, Address: d.Address, Values: d.Values,
		HeadersMode: hm, CreatedAt: now, UpdatedAt: now,
	}
	v := Variable{
		ID: newID("var"), Name: name, DisplayName: display, SourceID: src.ID,
		Description: d.Description, Transform: cloneJSON(d.Transform), Value: cloneJSON(d.Result.Value),
		ValueType: d.Result.ValueType, Columns: append([]string(nil), d.Result.Columns...),
		CreatedAt: now, UpdatedAt: now, LastError: nil,
	}
	oldS, oldV := len(p.Sources), len(p.Variables)
	oldUpdated := p.UpdatedAt
	p.Sources = append(p.Sources, src)
	p.Variables = append(p.Variables, v)
	p.UpdatedAt = now
	if err := s.saveLocked(); err != nil {
		p.Sources = p.Sources[:oldS]
		p.Variables = p.Variables[:oldV]
		p.UpdatedAt = oldUpdated
		return Source{}, Variable{}, err
	}
	return cloneJSON(src), cloneJSON(v), nil
}

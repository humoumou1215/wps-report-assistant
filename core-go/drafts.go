package main

import (
	"sync"
	"time"
)

const draftTTL = 30 * time.Minute

type VariableDraft struct {
	ID                string              `json:"id"`
	ProjectID         string              `json:"projectId"`
	DocumentID        string              `json:"documentId"`
	SheetName         string              `json:"sheetName"`
	Address           string              `json:"address"`
	Values            any                 `json:"-"`
	HeadersMode       string              `json:"headersMode"`
	Name              string              `json:"name"`
	DisplayName       string              `json:"displayName"`
	Description       string              `json:"description"`
	Transform         map[string]any      `json:"transform"`
	Result            TransformResult     `json:"result"`
	Generation        string              `json:"generation"`
	Attempts          []GenerationAttempt `json:"attempts"`
	Validation        ContractValidation  `json:"validation"`
	Graph             GraphValidation     `json:"graphValidation"`
	Critic            SemanticReview      `json:"critic"`
	DynamicCapability bool                `json:"dynamicCapability"`
	TraceID           string              `json:"traceId"`
	CreatedAt         time.Time           `json:"-"`
}

type BindingDraft struct {
	ID                string              `json:"id"`
	ProjectID         string              `json:"projectId"`
	VariableID        string              `json:"variableId"`
	DocumentID        string              `json:"documentId"`
	Target            map[string]any      `json:"target"`
	Description       string              `json:"description"`
	Renderer          map[string]any      `json:"renderer"`
	Plan              map[string]any      `json:"plan"`
	Generation        string              `json:"generation"`
	Attempts          []GenerationAttempt `json:"attempts"`
	Validation        ContractValidation  `json:"validation"`
	Graph             GraphValidation     `json:"graphValidation"`
	Critic            SemanticReview      `json:"critic"`
	DynamicCapability bool                `json:"dynamicCapability"`
	TraceID           string              `json:"traceId"`
	CreatedAt         time.Time           `json:"-"`
}

type DraftStore struct {
	mu        sync.Mutex
	variables map[string]VariableDraft
	bindings  map[string]BindingDraft
}

func NewDraftStore() *DraftStore {
	return &DraftStore{variables: map[string]VariableDraft{}, bindings: map[string]BindingDraft{}}
}

func (d *DraftStore) cleanupLocked() {
	cutoff := time.Now().Add(-draftTTL)
	for id, x := range d.variables {
		if x.CreatedAt.Before(cutoff) {
			delete(d.variables, id)
		}
	}
	for id, x := range d.bindings {
		if x.CreatedAt.Before(cutoff) {
			delete(d.bindings, id)
		}
	}
}

func (d *DraftStore) PutVariable(v VariableDraft) VariableDraft {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.cleanupLocked()
	if v.ID == "" {
		v.ID = newID("draftv")
	}
	v.CreatedAt = time.Now()
	d.variables[v.ID] = v
	return v
}

func (d *DraftStore) TakeVariable(projectID, id string) (VariableDraft, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.cleanupLocked()
	v, ok := d.variables[id]
	if !ok || v.ProjectID != projectID {
		return VariableDraft{}, appErr(404, "变量预览已过期，请重新生成预览")
	}
	delete(d.variables, id)
	return v, nil
}

func (d *DraftStore) PutBinding(v BindingDraft) BindingDraft {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.cleanupLocked()
	if v.ID == "" {
		v.ID = newID("draftb")
	}
	v.CreatedAt = time.Now()
	d.bindings[v.ID] = v
	return v
}

func (d *DraftStore) TakeBinding(projectID, id string) (BindingDraft, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.cleanupLocked()
	v, ok := d.bindings[id]
	if !ok || v.ProjectID != projectID {
		return BindingDraft{}, appErr(404, "绑定预览已过期，请重新生成预览")
	}
	delete(d.bindings, id)
	return v, nil
}

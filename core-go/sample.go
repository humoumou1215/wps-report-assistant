package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func copySampleFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err = os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func sampleOutputDir() string {
	if runtime.GOOS == "windows" {
		if u := os.Getenv("USERPROFILE"); u != "" {
			d := filepath.Join(u, "Documents")
			if st, err := os.Stat(d); err == nil && st.IsDir() {
				return filepath.Join(d, "DataReportAssistant-标准测试项目")
			}
		}
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, "DataReportAssistant-标准测试项目")
	}
	return filepath.Join(".", "DataReportAssistant-标准测试项目")
}

func (s *Server) prepareSampleProject() (Project, []string, error) {
	names := []struct{ file, kind string }{
		{"标准测试-本年预算.xlsx", "et"},
		{"标准测试-历史预算.xlsx", "et"},
		{"标准测试-预算汇报.pptx", "wpp"},
		{"调试步骤.md", ""},
	}
	outDir := sampleOutputDir()
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return Project{}, nil, err
	}
	paths := []string{}
	for _, n := range names {
		src := filepath.Join(s.sampleDir, n.file)
		if _, err := os.Stat(src); err != nil {
			return Project{}, nil, fmt.Errorf("标准测试文件缺失：%s", n.file)
		}
		dst := filepath.Join(outDir, n.file)
		if err := copySampleFile(src, dst); err != nil {
			return Project{}, nil, err
		}
		paths = append(paths, dst)
	}

	// 如果样例文件已经属于同一项目，直接复用。
	var existing *Project
	for _, n := range names[:3] {
		p, _ := s.store.ResolveProject(filepath.Join(outDir, n.file))
		if p != nil {
			existing = p
			break
		}
	}
	var p Project
	var err error
	if existing != nil {
		p = *existing
	} else {
		p, err = s.store.CreateProject("标准测试项目")
		if err != nil {
			return Project{}, nil, err
		}
	}
	for _, n := range names[:3] {
		_, err = s.store.RegisterDocument(p.ID, map[string]any{"key": filepath.Join(outDir, n.file), "name": n.file, "kind": n.kind})
		if err != nil {
			return Project{}, nil, err
		}
	}
	p, err = s.store.GetProject(p.ID)
	if err != nil {
		return Project{}, nil, err
	}
	if runtime.GOOS == "windows" {
		_ = exec.Command("explorer.exe", outDir).Start()
	}
	return p, paths, nil
}

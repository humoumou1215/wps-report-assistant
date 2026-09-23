package main

import (
	"fmt"
	"strings"
)

type installedProcess interface {
	imagePath() (string, error)
	stopAndWait() error
	close()
}

func normalizedWindowsImage(path string) string {
	path = strings.ReplaceAll(path, "/", `\`)
	path = strings.TrimPrefix(path, `\\?\`)
	return strings.ToLower(path)
}

// Verify the executable on the same handle used for termination. PID reuse
// cannot make us terminate a different process between inspection and stopping.
func stopMatchingAgent(expected string, processes []installedProcess) error {
	defer func() {
		for _, p := range processes {
			p.close()
		}
	}()
	for _, p := range processes {
		path, err := p.imagePath()
		if err != nil {
			return fmt.Errorf("无法确认 Agent Host 进程路径，未替换程序：%w", err)
		}
		if normalizedWindowsImage(path) != normalizedWindowsImage(expected) {
			continue
		}
		if err = p.stopAndWait(); err != nil {
			return fmt.Errorf("无法停止 Agent Host，未替换程序。请关闭该用户的数据报告助手后重试：%w", err)
		}
	}
	return nil
}

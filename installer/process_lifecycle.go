package main

import (
	"fmt"
	"strings"
)

type coreProcess interface {
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
func stopMatchingCore(expected string, processes []coreProcess) error {
	defer func() {
		for _, p := range processes {
			p.close()
		}
	}()
	for _, p := range processes {
		path, err := p.imagePath()
		if err != nil {
			return fmt.Errorf("无法确认 Core 进程路径，未替换程序：%w", err)
		}
		if normalizedWindowsImage(path) != normalizedWindowsImage(expected) {
			continue
		}
		if err = p.stopAndWait(); err != nil {
			return fmt.Errorf("无法停止旧版 Core，未替换程序。请关闭该用户的数据报告助手后重试：%w", err)
		}
	}
	return nil
}

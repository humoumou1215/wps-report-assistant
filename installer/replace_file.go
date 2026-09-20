package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Stage a complete file before replacing the destination. If a scanner or
// another process still holds it, preserve the existing file and retry briefly.
func replaceInstalledFile(dst string, data []byte, mode os.FileMode) error {
	temp, err := os.CreateTemp(filepath.Dir(dst), ".ra-install-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if _, err = temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	if err = os.Chmod(name, mode); err != nil {
		return err
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err = os.Rename(name, dst); err == nil {
			return nil
		}
		if !retryReplacement(err) || time.Now().After(deadline) {
			return fmt.Errorf("无法替换 %s；文件仍被占用或没有写入权限，原文件已保留：%w", dst, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

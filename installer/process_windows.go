//go:build windows

package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var queryFullProcessImageName = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryFullProcessImageNameW")

type windowsAgentProcess struct{ handle syscall.Handle }

func (p *windowsAgentProcess) close() { syscall.CloseHandle(p.handle) }
func (p *windowsAgentProcess) imagePath() (string, error) {
	var buffer [32768]uint16
	size := uint32(len(buffer))
	ok, _, err := queryFullProcessImageName.Call(uintptr(p.handle), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return "", err
	}
	return syscall.UTF16ToString(buffer[:size]), nil
}
func (p *windowsAgentProcess) stopAndWait() error {
	status, err := syscall.WaitForSingleObject(p.handle, 0)
	if err != nil {
		return err
	}
	if status == syscall.WAIT_OBJECT_0 {
		return nil
	}
	if err = syscall.TerminateProcess(p.handle, 0); err != nil {
		if status, _ = syscall.WaitForSingleObject(p.handle, 0); status != syscall.WAIT_OBJECT_0 {
			return err
		}
	}
	status, err = syscall.WaitForSingleObject(p.handle, 10000)
	if err != nil {
		return err
	}
	if status != syscall.WAIT_OBJECT_0 {
		return fmt.Errorf("等待旧进程退出超时（状态 %d）", status)
	}
	return nil
}
func stopAgentIfOurs(appDir string) error {
	return stopExecutableIfOurs(filepath.Join(appDir, "runtime", "node.exe"), "node.exe")
}
func stopExecutableIfOurs(expected, name string) error {
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return fmt.Errorf("无法读取运行进程：%w", err)
	}
	defer syscall.CloseHandle(snapshot)
	entry := syscall.ProcessEntry32{Size: uint32(unsafe.Sizeof(syscall.ProcessEntry32{}))}
	var processes []installedProcess
	// PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE
	for err = syscall.Process32First(snapshot, &entry); err == nil; err = syscall.Process32Next(snapshot, &entry) {
		if !strings.EqualFold(syscall.UTF16ToString(entry.ExeFile[:]), name) {
			continue
		}
		handle, e := syscall.OpenProcess(0x1000|0x0001|0x00100000, false, entry.ProcessID)
		if e != nil {
			// The process may have exited since enumeration.
			if e == syscall.Errno(87) {
				continue
			}
			for _, p := range processes {
				p.close()
			}
			return fmt.Errorf("无法检查 Agent Host 进程 %d；请关闭该进程后重试：%w", entry.ProcessID, e)
		}
		processes = append(processes, &windowsAgentProcess{handle: handle})
	}
	if err != syscall.ERROR_NO_MORE_FILES {
		for _, p := range processes {
			p.close()
		}
		return fmt.Errorf("读取运行进程失败：%w", err)
	}
	return stopMatchingAgent(expected, processes)
}

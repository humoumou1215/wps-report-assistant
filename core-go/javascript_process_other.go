//go:build !windows

package main

import "os/exec"

func configureScriptProcess(cmd *exec.Cmd) {}

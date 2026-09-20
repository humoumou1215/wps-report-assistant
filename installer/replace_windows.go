//go:build windows

package main

import (
	"errors"
	"syscall"
)

func retryReplacement(err error) bool {
	return errors.Is(err, syscall.Errno(32)) || errors.Is(err, syscall.Errno(33)) || errors.Is(err, syscall.ERROR_ACCESS_DENIED)
}

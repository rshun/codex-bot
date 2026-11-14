//go:build !windows

package updater

import (
	"fmt"
	"os"
	"syscall"
)

const posixWOK = 0x2

// checkDirWritable probes write permission on dir using access(2) without creating or deleting files.
func checkDirWritable(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s 不是目录", dir)
	}
	if err := syscall.Access(dir, posixWOK); err != nil {
		return fmt.Errorf("当前运行用户对目录 %s 无写入权限: %w", dir, err)
	}
	return nil
}

// ExecSelf replaces the current process image in-place with exePath (preserving PID under systemd).
func ExecSelf(exePath string, argv []string, envv []string) error {
	if len(argv) == 0 {
		argv = []string{exePath}
	} else {
		copied := make([]string, len(argv))
		copy(copied, argv)
		copied[0] = exePath
		argv = copied
	}
	return syscall.Exec(exePath, argv, envv)
}

//go:build darwin

package main

import (
	"embed"
	"flag"
	"fmt"
	"html"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

//go:embed payload
var macPayload embed.FS

func macExtract(target string) error {
	if compressed, err := macPayload.ReadFile("payload/payload.zip"); err == nil {
		return extractZipPayload(compressed, target, func(path string) bool {
			return filepath.Ext(path) == ".exe"
		})
	}
	return fs.WalkDir(macPayload, "payload/app", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel("payload/app", path)
		if err != nil {
			return err
		}
		dest := filepath.Join(target, rel)
		if d.IsDir() {
			return os.MkdirAll(dest, 0755)
		}
		if filepath.Ext(dest) == ".exe" {
			return nil
		}
		data, err := macPayload.ReadFile(path)
		if err != nil {
			return err
		}
		return replaceInstalledFile(dest, data, 0644)
	})
}
func main() {
	uninstall := flag.Bool("uninstall", false, "remove this add-in, retaining project data")
	noService := flag.Bool("no-service", false, "register assets without starting the launch agent")
	flag.Parse()
	home, err := os.UserHomeDir()
	if err != nil {
		panic(err)
	}
	base := filepath.Join(home, "Library", "Application Support", "DataReportAssistant")
	appDir := filepath.Join(base, "app")
	dataDir := filepath.Join(base, "data")
	publish := filepath.Join(home, "Library", "Containers", "com.kingsoft.wpsoffice.mac", "Data", ".kingsoft", "wps", "jsaddons", "publish.xml")
	agent := filepath.Join(home, "Library", "LaunchAgents", "com.datareportassistant.core.plist")
	domain := "gui/" + strconv.Itoa(os.Getuid())
	fail := func(err error) {
		if err != nil {
			fmt.Fprintln(os.Stderr, "安装失败：", err)
			os.Exit(1)
		}
	}
	if *uninstall {
		fail(mergePublish(publish, false))
		_ = exec.Command("launchctl", "bootout", domain, agent).Run()
		fail(os.RemoveAll(appDir))
		if err := os.Remove(agent); err != nil && !os.IsNotExist(err) {
			fail(err)
		}
		fmt.Println("已卸载插件；项目与修改历史保留在", dataDir)
		return
	}
	_ = exec.Command("launchctl", "bootout", domain, agent).Run()
	fail(os.MkdirAll(appDir, 0755))
	fail(os.MkdirAll(dataDir, 0700))
	fail(macExtract(appDir))
	fail(os.Chmod(filepath.Join(appDir, "runtime", "node"), 0755))
	fail(mergePublish(publish, true))
	if !*noService {
		fail(os.MkdirAll(filepath.Dir(agent), 0755))
		binary := html.EscapeString(filepath.Join(appDir, "runtime", "node"))
		entry := html.EscapeString(filepath.Join(appDir, "agent-host", "dist", "agent-host", "src", "main.js"))
		data := html.EscapeString(dataDir)
		assets := html.EscapeString(filepath.Join(appDir, "addins"))
		logs := html.EscapeString(filepath.Join(dataDir, "launch.log"))
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.datareportassistant.core</string><key>ProgramArguments</key><array><string>%s</string><string>%s</string></array><key>EnvironmentVariables</key><dict><key>REPORT_ASSISTANT_DATA_DIR</key><string>%s</string><key>REPORT_ASSISTANT_ASSET_DIR</key><string>%s</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>%s</string><key>StandardErrorPath</key><string>%s</string></dict></plist>`, binary, entry, data, assets, logs, logs)
		fail(os.WriteFile(agent, []byte(plist), 0644))
		_ = exec.Command("launchctl", "bootout", domain, agent).Run()
		output, err := exec.Command("launchctl", "bootstrap", domain, agent).CombinedOutput()
		if err != nil {
			fail(fmt.Errorf("无法启动本地服务：%s (%w)", output, err))
		}
	}
	fmt.Println("数据报告助手已安装。请关闭并重新打开 WPS，在“数据报告助手”选项卡点击“打开助手”。")
	fmt.Println("加载项配置：", publish)
	fmt.Println("项目数据：", dataDir)
}

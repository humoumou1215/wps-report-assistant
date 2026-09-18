package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var ownEntry = regexp.MustCompile(`(?is)<jsplugin(online)?\b[^>]*\bname\s*=\s*["'](DataReportAssistantET|DataReportAssistantWPP|report-assistant-et|report-assistant-wpp)["'][^>]*/\s*>`)

func mergePublish(file string, install bool) error {
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return err
	}
	content := `<?xml version="1.0" encoding="UTF-8"?>` + "\r\n<jsplugins>\r\n</jsplugins>\r\n"
	if b, err := os.ReadFile(file); err == nil {
		content = string(b)
		backup := file + ".backup-before-data-report-assistant"
		if _, e := os.Stat(backup); os.IsNotExist(e) {
			_ = os.WriteFile(backup, b, 0644)
		}
	}
	content = ownEntry.ReplaceAllString(content, "")
	if !strings.Contains(strings.ToLower(content), "</jsplugins>") {
		return fmt.Errorf("现有 publish.xml 格式异常，未找到 </jsplugins>。为避免影响其他 WPS 插件，安装已停止。文件：%s", file)
	}
	if install {
		entries := `  <jspluginonline name="DataReportAssistantET" url="http://127.0.0.1:17891/addins/et/" type="et" enable="true"/>` + "\r\n" +
			`  <jspluginonline name="DataReportAssistantWPP" url="http://127.0.0.1:17891/addins/wpp/" type="wpp" enable="true"/>` + "\r\n"
		idx := strings.LastIndex(strings.ToLower(content), "</jsplugins>")
		content = content[:idx] + entries + content[idx:]
	}
	return os.WriteFile(file, []byte(content), 0644)
}

# 中国大陆非工作日提醒

非工作日按周六、周日及官方公布的放假日期判断，官方调休工作日优先排除。当前内置 `china-calendar.json` 仅覆盖 2026 年，数据依据 [国务院办公厅关于2026年部分节假日安排的通知](https://www.gov.cn/zhengce/content/202511/content_7047090.htm)，可对照 [地方政府转载全文](https://www.xjhc.gov.cn/xjhc/c113364/202512/37f6e22476a746d4a40f108faa2a2baa.shtml)。不把未公布的未来年份推测为“仅周末”。

## 使用和验收

TG 私聊发送“非工作日早上6点1分、11点2分提醒我测试消息”，会创建两条独立任务，内容均为“测试消息”。也支持“请在节假日的早上6点1分，11点2分添加添加定时任务： 在tg上发送测试消息”。只有收到两条任务 ID 及下次时间才算创建成功；列表由“查看我的提醒”获取，可逐个按 ID 取消。当前私聊已确定收件人，不必向模型提供 Bot Token 或 chat_id。Discord 同样支持非工作日句式，但不能用它向 TG 跨平台发送。

时间固定为北京时间。逗号、顿号或“和”可分隔多个时间，最多 8 个；重复时间只创建一次。缺少时段的后续“几点几分”继承上一个明确时段；完整的 `HH:mm` 使用 24 小时制。时间或内容任一无效、日历覆盖不足、总记录或待发数量超限时，不保存整个请求。批量保存失败不发布任何部分状态。

验收应确认调休工作日不发送、普通周末和放假日发送，并验证同一天两个时间各收到一次、重启恢复、按 ID 取消和修改。可用“把提醒 任务ID 改成非工作日 07:00”保留非工作日规则；若明确改成“每天 07:00”或指定日期，则会改变规则，回执会显示新计划，不默认保持原规则。内容匹配多个任务时先选择 ID，不批量修改。

服务离线时不能发送。恢复后不在工作日补发，不重放过去日期；在已覆盖的非工作日，仅按当天计划等待或补发每个时间点一次。网络或平台队列可能延迟实际到达，不能保证精确到秒。发送未确认仍不重试该轮。

## 更新日历

日历为离线 JSON，普通运行不联网获取节假日，也不安装依赖。可将核实后的日历放在稳定的私有目录，通过两个平台各自环境中的可选 `HOLIDAY_CALENDAR_FILE` 指向它；不设置则读取当前运行包旁的内置文件。配置变更前备份原配置和日历，保留原运行账号及权限，不覆盖原配置。一个文件可以由两个进程只读使用，提醒状态文件仍不能共用。

格式如下，省略号仅作说明，不能直接粘贴成 JSON：

```text
{
  "version": 1,
  "years": {
    "2026": {
      "source": "https://www.gov.cn/zhengce/content/202511/content_7047090.htm",
      "holidays": ["2026-01-01", "...完整放假日期..."],
      "workdays": ["2026-01-04", "...完整调休上班日期..."]
    }
  }
}
```

先复制内置完整文件，再按官方公告增加相应年份。`holidays` 包含公告全部放假日期（包括假期内周末），`workdays` 包含全部调休上班日期；同一日期不可重复、不可同时出现在两组，日期必须有效且属于该年份。仅提供完整且已核实的年度安排；加载器能校验结构和日期，不能证明人工录入的日期与官方公告一致。不要用空数组假装已掌握未来安排。

更新前先备份，更新后可用 `node -e 'new (require("./china-calendar").ChinaCalendar)(process.argv[1]); console.log("Calendar structure checked")' /实际日历路径` 在运行包目录做本地结构检查；该命令不联网、不发送、不写状态。确认服务空闲并避开提醒时段后，由操作者受控重启对应服务（会中断该平台及运行任务），再查看任务列表。包升级时保持自定义日历绝对路径稳定。

创建时如果下一个非工作日超出覆盖范围，整个请求不创建。已有非工作日任务在跨到未覆盖年份时变为“日历待更新”，不会猜测或重复最后一轮，普通任务继续；补齐覆盖后重启，只重新安排未来时间，不补未知期间消息。日历本身损坏或自定义路径无效则启动检查失败，应修复文件，不要清空提醒状态。

## 状态兼容和降级

只有旧的一次性/每天任务时继续使用版本 1 状态。创建或转换出非工作日任务后，保存为版本 2，保留原任务并新增 `nonworking` 类型；缺日历时使用 `calendar_wait` 状态。v1.4.0 及更早版本不能读取这类文件，会拒绝启动，不能直接降级后复用原状态路径。取消任务不删除记录，因此也不会自动变回旧格式。

降级会使非工作日任务停止调度。先确认空闲，受控停止需要降级的平台以冻结状态（会断开连接并中断运行任务，必须由操作者确认并执行），备份实际配置、unit、drop-in、当前完整提醒状态和会话，保留所有新版文件。不要恢复升级前的陈旧状态覆盖期间新增、修改或发送结果。

可以从冻结后的完整状态**导出一个新的、独立的兼容副本**，只供旧版使用；源文件不改变，非工作日任务和历史仍完整留在源文件。以下为操作者命令，路径须替换为实际路径，目标必须原先不存在：

```bash
STATE_FILE=/实际私有目录/telegram-reminders.json
LEGACY_STATE=/实际私有目录/telegram-reminders-v1-export.json
node -e 'const fs=require("node:fs"); const src=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(![1,2].includes(src.version)||!Array.isArray(src.items))throw Error("Invalid state"); const items=src.items.filter(t=>t.kind==="once"||t.kind==="daily"); if(src.items.some(t=>t.status==="sending"))throw Error("Sending task must be resolved before exporting"); fs.writeFileSync(process.argv[2],JSON.stringify({...src,version:1,items},null,2)+"\n",{flag:"wx",mode:0o600}); console.log("Exported compatible tasks:",items.length,"; nonworking records retained in source:",src.items.length-items.length);' "$STATE_FILE" "$LEGACY_STATE"
```

导出失败不得切换。在旧运行包目录，用旧版 `ReminderScheduler` 构造器加载此副本验证（平台和授权 ID 按实际值替换），它只读文件，不启动定时器、不发送消息：

```bash
node -e 'const fs=require("node:fs"); const {ReminderScheduler}=require("./reminders"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); new ReminderScheduler({filename:process.argv[1],platform:data.platform,userId:data.userId,send:async()=>{throw Error("Validation only");}}); console.log("Legacy state checked; no scheduler started");' "$LEGACY_STATE"
```

验证后手动恢复旧 unit 入口，并将它的 `REMINDER_FILE` 改为兼容副本绝对路径，再受控启动及验收。不能同时运行两个版本或让它们共享状态。日后恢复新版时，旧版运行期间兼容副本中的新任务/修改/发送结果与原完整文件需要人工核对合并，不能直接切回旧快照，否则可能漏任务或重复补发；两个文件都应保留。

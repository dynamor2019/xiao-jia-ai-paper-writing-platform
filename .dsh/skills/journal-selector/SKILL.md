---
name: journal-selector
description: 为 AI、MEP、HVAC、建筑环境、建筑能源、建筑自动化和工程信息学论文选择非 MDPI 目标期刊；当用户询问适合投哪里、尚未确定期刊或需要比较期刊范围时使用。
---

# AI + MEP 期刊选择

## 硬约束

- 不推荐、不中转、也不生成任何 MDPI 期刊方案。
- 不以影响因子作为唯一依据；先判断论文的核心贡献，再判断证据强度和投稿格式。
- 期刊指标、费用、篇幅和模板会变化，投稿前必须通过对应 skill 的官方链接复核。

## 匹配路径

| 论文主贡献 | 优先检查的 skill |
|---|---|
| 建筑全生命周期、BIM、施工/运维自动化 | `journal-automation-in-construction` |
| 知识表示、工程信息学、知识驱动决策 | `journal-advanced-engineering-informatics` |
| 土木工程计算、AI、传感、机器人 | `journal-journal-of-computing-in-civil-engineering` |
| 强计算方法创新与基础设施验证 | `journal-computer-aided-civil-and-infrastructure-engineering` |
| 室内环境、HVAC、舒适、建筑物理 | `journal-building-and-environment` |
| 建筑能耗、负荷、控制、减碳 | `journal-energy-and-buildings` |
| 广义建筑工程与 MEP 应用 | `journal-journal-of-building-engineering` |
| HVAC&R、控制、故障检测、仿真 | `journal-science-and-technology-for-the-built-environment` |
| 建筑服务工程与工程实践 | `journal-building-services-engineering-research-and-technology` |
| AI 方法与工程应用双重贡献 | `journal-engineering-applications-of-artificial-intelligence` |
| 自动化科学、系统方法、工程部署 | `journal-ieee-transactions-on-automation-science-and-engineering` |
| 智能系统、决策支持、可解释应用 | `journal-expert-systems-with-applications` |

## 选择输出

给出 2-4 个范围匹配候选，并分别说明匹配点、可能的 desk-reject 风险、当前证据缺口和对应 `--journal` ID；用户确认后加载该刊 skill，再开始大纲与正文。

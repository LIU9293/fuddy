# Roombase · 2026-08-04 每日总结

> 一句话结论：交易基本盘高于近期均值，但首次预订用户偏弱，应优先检查激活环节。

## 需要关注

1. **首次产生预订的用户降至 93 人。** 较前一日下降 34.5%，较 7 日均值下降 19.1%。同期新增用户为 211 人，只比 7 日均值低 7.5%。**推断：** 首次预订的下降幅度不能只用新增用户减少解释，值得继续拆分首次预订前的路径；这不是同日注册转化率，当前数据不能证明具体原因。
2. **小程序接入存在长期积压。** 当前有 5 个未完成 onboarding，其中 4 个等待平台处理，等待平台的最长未活跃时间为 70.4 天；另有 1 个明确阻塞。需要先区分真实商户、历史遗留和测试数据，再决定是否进入运营跟进。

## 基本盘

预订用户 909（较 7 日均值 +5.3%） · 预订 1,259 笔（+6.4%） · 成功支付 385 笔（+4.5%） · 净实收 ¥31,648.85（+16.7%） · 预订取消率 6.83%（前一日 8.15%） · 支付成功占比 85.37%（前一日 83.04%）

## 建议动作

1. 把首次预订用户按门店、注册时间段和可用来源字段拆分，建立真正的“注册后 24 小时 / 7 天首次预订” cohort，确认问题发生在获客质量还是首次使用流程。
2. 复核 5 个未完成 onboarding，优先处理等待平台超过合理时限的记录；历史或测试记录单独标记，避免持续污染运营简报。

## 数据说明

- 时间窗口为 `Asia/Shanghai` 的完整自然日；报告日是前一日。
- `firstBookingUsers` 是当天首次产生预订的独立用户，不是当天注册用户的转化率。
- 预订按 `bookings.created_at` 归日，状态为查询时的当前状态。
- 净实收使用 `amount_paid - amount_refunded`；当前 `amount_net_received` 未填充。

```json
{
  "signals": [
    {
      "kind": "decision",
      "title": "首次预订用户低于 7 日均值 19.1%",
      "impact": "交易基本盘仍健康，但新用户开始产生实际使用的速度偏弱，可能影响后续活跃与付费增长。",
      "urgency": "medium",
      "evidenceMetricKeys": ["metrics.firstBookingUsers", "metrics.newUsers"],
      "suggestedActions": ["建立注册后首次预订 cohort", "按门店和来源拆分首次预订"]
    },
    {
      "kind": "risk",
      "title": "小程序 onboarding 最长等待平台 70.4 天",
      "impact": "长期积压可能延迟商户上线，也可能说明历史或测试数据没有被正确关闭。",
      "urgency": "medium",
      "evidenceMetricKeys": ["snapshot.open_onboardings", "snapshot.waiting_platform_onboardings", "snapshot.oldest_waiting_platform_days"],
      "suggestedActions": ["核对未完成 onboarding 清单", "区分真实商户与历史测试记录"]
    }
  ]
}
```

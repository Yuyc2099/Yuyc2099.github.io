# RT-Thread 任务启动与任务切换原理

<!--
Author: Yuyc2099
Source-Repository: https://github.com/Yuyc2099/Yuyc2099.github.io
Source-ID: yuyc2099:rt-thread-task-context-switch:2026-08-25
-->

本文基于 Cortex-M4 的 RVDS 实现，分析 RT-Thread 第一个任务的启动、运行期间的任务切换，以及 `PendSV_Handler` 保存和恢复上下文的原理。

> 本文源码基于 RT-Thread v3.1.5。

## 1. 任务启动

### 1.1 `rtthread_startup` 启动调度原理

省略与首个任务启动无关的初始化后，关键调用关系如下：

```calltree
rtthread_startup()
|   // 选择并启动最高优先级就绪线程
└── rt_system_scheduler_start()
    │   // 按就绪位图取得最高优先级，具体算法见优先级位图文章
    ├── [获取 highest_ready_priority](/articles/rt-thread-ready-priority-bitmap/)
    │   // 从该优先级链表取得首个就绪线程
    ├── to_thread = rt_list_entry(rt_thread_priority_table[highest_ready_priority].next);
    |   // 记录首个当前线程
    ├── rt_current_thread = to_thread;
    │   // 启动首个就绪线程，具体过程见 1.2
    └── [rt_hw_context_switch_to(&to_thread->sp)](#rt-hw-context-switch-to)
```

{% source file="snippets/rtthread_startup.c" lang="c" title="rtthread_startup()" origin="src/components.c" %}

{% source file="snippets/rt_system_scheduler_start.c" lang="c" title="rt_system_scheduler_start()" origin="src/scheduler.c" %}

<div id="rt-hw-context-switch-to" class="section-anchor"></div>

### 1.2 `rt_hw_context_switch_to` 任务切换原理

`rt_hw_context_switch_to` 只用于启动第一个任务。它把 `&to_thread->sp` 保存到 `rt_interrupt_to_thread`，将 `rt_interrupt_from_thread` 清零，并设置切换标志。随后将 PendSV 设为最低优先级并挂起，恢复初始 MSP 后打开中断。PendSV 发现来源任务为空，便跳过旧现场保存，直接恢复目标任务。

```calltree
rt_hw_context_switch_to(&to_thread->sp)
│   // 保存目标线程 sp 字段地址，PendSV 通过它取得目标栈顶
├── rt_interrupt_to_thread = &to_thread->sp;
│   // 首次启动没有来源线程，PendSV 无需保存旧上下文
├── rt_interrupt_from_thread = RT_NULL;
│   // 标记切换请求待处理
├── rt_thread_switch_interrupt_flag = 1;
│   // 将 PendSV 和 SysTick 设为最低优先级
├── set_priority(PendSV, SysTick, lowest);
│   // 设置 PendSV 挂起位
├── pend(PendSV);
│   // 恢复初始主栈顶，启动函数不再返回
├── MSP = get(vector_table[0]);
│   // 开中断后响应 PendSV，具体处理见第 3 章
└── enable_interrupt()
    └── [PendSV_Handler()](#pendsv-handler)
```

{% source file="snippets/rt_hw_context_switch_to.S" lang="asm" title="rt_hw_context_switch_to()" origin="libcpu/arm/cortex-m4/context_rvds.S" %}

## 2. 任务切换

### 2.1 线程切换流程

任务切换分为选择目标线程、提交切换请求和 PendSV 切换上下文三步。线程环境与中断环境使用不同入口，但共用同一段切换请求代码。

```calltree
触发调度
│   // 主动让出、时间片耗尽或更高优先级线程就绪
└── [rt_schedule()](#rt-schedule)
    ├── [无需切换] 当前线程继续运行
    └── [需要切换] 提交切换请求
        │   // 两个入口共用切换请求逻辑
        ├── [线程环境] [rt_hw_context_switch()](#rt-hw-context-switch)
        ├── [中断环境] [rt_hw_context_switch_interrupt()](#rt-hw-context-switch)
        │   // 请求最终由 PendSV 执行
        └── [PendSV 异常] [PendSV_Handler()](#pendsv-handler)
            └── 目标线程继续运行
```

<div id="rt-schedule" class="section-anchor"></div>

### 2.2 `rt_schedule` 逻辑与原理

`rt_schedule` 先关闭中断，并在调度器未锁定时从就绪表中选择最高优先级任务。若目标任务发生变化，它保存原来的 `rt_current_thread`，再更新当前任务。在线程环境中调用 `rt_hw_context_switch`，在中断环境中调用 `rt_hw_context_switch_interrupt`；两者在该汇编文件中共用同一段切换请求代码。

忽略调试、Hook、栈检查和信号处理后，关键控制流如下：

```calltree
rt_schedule()
│   // 关闭中断并保存原 PRIMASK
├── level = rt_hw_interrupt_disable();
│   // 调度器未锁定时才重新选择线程
├── if (rt_scheduler_lock_nest == 0)
│   │   // 按就绪位图取得最高优先级，具体算法见优先级位图文章
│   ├── [获取 highest_ready_priority](/articles/rt-thread-ready-priority-bitmap/)
│   │   // 从该优先级链表取得首个就绪线程
│   ├── to_thread = rt_list_entry(rt_thread_priority_table[highest_ready_priority].next);
│   │   // 目标变化时才提交上下文切换
│   └── if (to_thread != rt_current_thread)
│       ├── rt_current_priority = highest_ready_priority;
│       ├── from_thread = rt_current_thread;
│       ├── rt_current_thread = to_thread;
│       │   // 线程环境提交请求后恢复中断并直接返回
│       ├── if (rt_interrupt_nest == 0)
│       │   ├── [rt_hw_context_switch(&from_thread->sp, &to_thread->sp)](#rt-hw-context-switch)
│       │   ├── rt_hw_interrupt_enable(level);
│       │   └── return;
│       │   // 中断环境提交请求后，继续走函数末尾
│       └── else
│           └── [rt_hw_context_switch_interrupt(&from_thread->sp, &to_thread->sp)](#rt-hw-context-switch)
│   // 锁定、无需切换或中断环境都从这里恢复中断
└── rt_hw_interrupt_enable(level);
```

{% source file="snippets/rt_schedule.c" lang="c" title="rt_schedule()" origin="src/scheduler.c" %}

<div id="rt-hw-context-switch" class="section-anchor"></div>

### 2.3 `rt_hw_context_switch` 逻辑与原理

该函数通过 `R0`、`R1` 接收 `&from_thread->sp` 和 `&to_thread->sp`，分别写入 `rt_interrupt_from_thread` 与 `rt_interrupt_to_thread`，然后设置切换标志并挂起 PendSV。若已有切换请求，`_reswitch` 会保留最初的来源任务，只更新最新的目标任务。该函数只提交请求，不直接切换寄存器和栈。

保留关键变量和分支后，切换请求流程如下：

```calltree
rt_hw_context_switch(from, to)
│   // 首次请求记录来源；已有请求则保留最初的来源任务
├── if (rt_thread_switch_interrupt_flag == 0)
│   ├── rt_thread_switch_interrupt_flag = 1;
│   └── rt_interrupt_from_thread = from;
│   // 每次请求都覆盖目标，因此最终切换到最新的目标任务
├── rt_interrupt_to_thread = to;
│   // 这里只提交请求，不直接保存或恢复上下文
└── pend(PendSV)
    └── [PendSV 异常] [PendSV_Handler()](#pendsv-handler)
```

{% source file="snippets/rt_hw_context_switch.S" lang="asm" title="rt_hw_context_switch()" origin="libcpu/arm/cortex-m4/context_rvds.S" %}

<div id="pendsv-handler" class="section-anchor"></div>

## 3. `PendSV_Handler` 逻辑与原理

异常进入时，硬件先把 `R0～R3`、`R12`、`LR`、`PC` 和 `xPSR` 压入当前栈；普通任务切换使用 PSP。PendSV 再保存 `R4～R11` 及必要的浮点寄存器，并把 PSP 写回 `from_thread->sp`；首次启动因来源任务为空而跳过此步。随后从 `to_thread->sp` 恢复现场并更新 PSP，最后通过 `EXC_RETURN` 返回目标任务。

省略寄存器搬运指令后，关键判断和数据流如下：

```calltree
PendSV_Handler()
│   // 保存原中断状态并关闭中断，保护上下文切换
├── saved_primask = PRIMASK;
├── disable_interrupt();
│   // 没有待处理请求时，不执行任务切换
├── if (rt_thread_switch_interrupt_flag == 0)
│   └── goto pendsv_exit;
│   // 消费本次切换请求
├── rt_thread_switch_interrupt_flag = 0;
│   // 首次启动的来源为空，直接跳过旧任务现场保存
├── if (rt_interrupt_from_thread != RT_NULL)
│   ├── from_sp = PSP;
│   ├── from_sp = push(from_sp, R4-R11, optional_fpu_context);
│   └── *rt_interrupt_from_thread = from_sp;
│   // 间接取得目标线程栈顶，并恢复软件保存的上下文
├── to_sp = *rt_interrupt_to_thread;
├── to_sp = pop(to_sp, R4-R11, optional_fpu_context);
├── PSP = to_sp;
└── pendsv_exit
    │   // 恢复进入 PendSV 前的中断状态
    ├── PRIMASK = saved_primask;
    │   // EXC_RETURN bit2 置 1，异常返回时使用 PSP
    ├── EXC_RETURN |= (1 << 2);
    └── exception_return();
```

{% source file="snippets/PendSV_Handler.S" lang="asm" title="PendSV_Handler" origin="libcpu/arm/cortex-m4/context_rvds.S" %}

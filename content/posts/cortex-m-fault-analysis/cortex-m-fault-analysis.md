---
title: "Cortex-M 异常分析：从栈帧到 HardFault 定位"
slug: cortex-m-fault-analysis
date: 2026-07-06
updated: 2026-07-21
summary: "面向 Cortex-M0/M0+/M3/M4，梳理异常入口栈帧、HardFault 定位、栈回溯、离线转储及常见软件缺陷。"
category: debugging
tags: [Cortex-M, HardFault, 异常, 栈回溯, TRACE32]
series: debugging-notes
cover: ./images/cover.svg
coverAlt: "Cortex-M 异常现场、寄存器与调用栈的抽象示意图"
readingTime: 19
draft: false
---

虽然 M0/M0+ 与 M3/M4 的异常体系不同（M3/M4 有 MemManage、BusFault 和 UsageFault，M0/M0+ 主要汇总到 HardFault），但异常入口的基本栈帧和常见软件缺陷具有共通性。本文先介绍通用的现场分析方法，再补充两类内核的异常差异。

---

## 1. 异常入口的栈帧处理

### 硬件自动压栈

发生异常时，Cortex-M 内核在跳转到异常向量前会**自动**将以下寄存器压入当前活动栈（MSP 或 PSP）：

| 偏移 | 寄存器 | 说明 |
|------|--------|------|
| +0x00 | R0 | 参数/返回值寄存器 |
| +0x04 | R1 | 参数寄存器 |
| +0x08 | R2 | 参数寄存器 |
| +0x0C | R3 | 参数寄存器 |
| +0x10 | R12 | 内部调用寄存器（IP） |
| +0x14 | LR | 链接寄存器（返回地址） |
| +0x18 | PC | 出错时的程序计数器 |
| +0x1C | xPSR | 程序状态寄存器（含 IPSR/EPSR/APSR） |

> 基本栈帧包含 8 个寄存器，共 32 字节。为满足 8 字节栈对齐，硬件可能额外加入一个 4 字节填充字，可通过栈中 xPSR 的 bit9 判断。Cortex-M4 使用浮点单元且异常发生时存在活动浮点上下文时，还可能压入扩展浮点栈帧。R4–R11 不在基本硬件栈帧中，其完整性由 AAPCS 调用约定保证——见下节。

### R4–R11 的保护机制

R4–R11 被 AAPCS 定义为 callee-saved（被调用者保存）。编译器对**每个 C 函数**（包括 ISR）都遵守同一条规则：**函数内部用到哪些就保存哪些，退出前恢复。**

以 `func1` 执行时被 `ISR2` 打断为例：

```
func1 正在执行：R4=0x10, R5=0x20，其余 R6-R11 也有值
    │
    ↓ 中断触发
    硬件自动压栈 R0–R3, R12, LR, PC, xPSR（与 R4-R11 无关）
    │
    ↓ 跳转到 ISR2
    编译器为 ISR2 生成序言：PUSH {R4, R5}   ← ISR2 自己要用 R4/R5，先保存当前值
    ISR2 执行，R4/R5 被改写为 ISR2 的中间结果
    编译器为 ISR2 生成尾声：POP  {R4, R5}   ← ISR2 退出前恢复成 0x10, 0x20
    │
    ↓ 异常返回
    硬件弹栈恢复 R0–R3, R12, LR, PC, xPSR
    │
func1 继续执行：R4=0x10, R5=0x20，与被打断前完全一致
```

关键点：**ISR2 保存/恢复的是它自己打算覆盖的寄存器，本质上是 ISR2 对自己行为负责，而不是主动替 func1 保护现场。** 结果上 func1 的 R4–R11 得到了保全，但这是 AAPCS 约定的副产品——ISR2 若完全不用 R4–R11，编译器不会生成任何 PUSH/POP，func1 的值同样不会被破坏。

### 判断使用哪个栈

异常发生时，LR 被设置为 EXC_RETURN 值，其 bit2 指示压栈前使用的是哪个栈：

| EXC_RETURN | 含义 |
|------------|------|
| `0xFFFFFFF9` | 返回 Thread 模式，使用 MSP |
| `0xFFFFFFFD` | 返回 Thread 模式，使用 PSP |
| `0xFFFFFFF1` | 返回 Handler 模式，使用 MSP（嵌套中断） |
| `0xFFFFFFE9` | 返回 Thread 模式，使用 MSP，恢复扩展浮点栈帧（M4） |
| `0xFFFFFFED` | 返回 Thread 模式，使用 PSP，恢复扩展浮点栈帧（M4） |
| `0xFFFFFFE1` | 返回 Handler 模式，使用 MSP，恢复扩展浮点栈帧（M4） |

在异常处理函数中通过检查 LR bit2 来获取正确的栈指针。下面给出 GCC 语法的示例；入口必须声明为 `naked`，避免编译器生成的函数序言在读取现场前改变栈。示例使用 Cortex-M0 也支持的 Thumb-1 指令，因此可用于本文讨论的几类内核：

```c
__attribute__((naked)) void HardFault_Handler(void)
{
    __asm volatile (
        "mov  r0, lr        \n"
        "movs r1, #4        \n"
        "tst  r0, r1        \n"  /* 检查 EXC_RETURN bit2 */
        "beq  1f            \n"
        "mrs  r0, psp       \n"  /* bit2=1：使用 PSP */
        "b    fault_handler_c \n"
        "1:                 \n"
        "mrs  r0, msp       \n"  /* bit2=0：使用 MSP */
        "b    fault_handler_c \n"
    );
}

void fault_handler_c(uint32_t *stack) {
    uint32_t r0   = stack[0];
    uint32_t r1   = stack[1];
    uint32_t r2   = stack[2];
    uint32_t r3   = stack[3];
    uint32_t r12  = stack[4];
    uint32_t lr   = stack[5];   /* 出错前的返回地址 */
    uint32_t pc   = stack[6];   /* 异常返回地址；精确 fault 时通常可定位出错指令 */
    uint32_t xpsr = stack[7];

    /* 在此打印或通过调试器查看上述寄存器以定位根因 */
    (void)r0; (void)r1; (void)r2; (void)r3;
    (void)r12; (void)lr; (void)pc; (void)xpsr;
    while (1);
}
```

如果 Cortex-M4 工程启用了浮点单元，还应检查 EXC_RETURN 的 bit4：bit4 为 0 表示存在扩展浮点栈帧，不能在不了解实际帧布局的情况下直接把入口 SP 当作上表中的基本栈帧。不同编译器的中断入口语法也不同，移植时应改用对应工具链的写法。

### M3/M4 附加诊断寄存器

M3/M4 在进入 fault 处理函数后可进一步读取：

- **CFSR**（`0xE000ED28`）：包含 UFSR / BFSR / MMFSR，指示具体错误类型
- **HFSR**（`0xE000ED2C`）：HardFault 状态，是否由其他 fault 升级而来
- **BFAR**（`0xE000ED38`）：触发 BusFault 的访问地址（BFSR.BFARVALID 有效时）
- **MMFAR**（`0xE000ED34`）：触发 MemManage Fault 的地址（MMFSR.MMARVALID 有效时）

> M0/M0+ 不存在上述寄存器，只能依赖栈帧中的 PC 值配合反汇编定位出错位置。

---

## 2. CmBacktrace 栈回溯原理

[CmBacktrace](https://github.com/armink/CmBacktrace) 是面向 Cortex-M 的异常栈回溯库，可在不依赖调试器的情况下，通过串口输出异常现场和可能的函数调用路径。

### 回溯的核心问题

异常发生时，硬件压栈只保存了出错瞬间的 PC，但无法直接知道"谁调用了出错函数、谁又调用了它的调用者"。要还原调用链，需要沿着栈向上逐帧追溯，每帧的关键字段是 **LR（返回地址）**，它指向上一层函数的调用点。

### 使用前提

**1. 正确配置代码段和栈范围**

CmBacktrace 通过扫描栈中的候选返回地址进行回溯，需要知道实际代码段范围、当前栈边界和栈顶位置。代码段不一定固定为整个 `0x08000000` 区域，应以链接脚本和固件布局为准。

**2. 保留同一次构建的 ELF 或 `.map` 文件**

回溯得到的是一组原始地址，需要使用同一次构建的 ELF 配合 `addr2line`，或对照 `.map` 文件转换为函数名和行号。CmBacktrace 的核心机制不是依赖 R11 固定帧指针，而是扫描栈并验证可能的 `BL`/`BLX` 返回地址。

### 回溯流程

```
1. 异常入口
   ├─ 读取 EXC_RETURN（LR），判断出错前用的是 MSP 还是 PSP
   ├─ 根据基本帧、浮点扩展帧和对齐填充确定现场布局
   └─ 得到：出错 PC、出错前 LR（即调用出错函数的返回地址）

2. 第一帧（出错帧）
   └─ PC → 出错指令地址，对应最底层出错函数

3. 向上回溯每一帧
   ├─ 当前帧的 LR 值 = 上一层函数的返回地址（调用点的下一条指令）
   ├─ 在栈内向高地址扫描，寻找下一个合法 LR 值：
   │    • 地址落在工程配置的代码段范围内
   │    • bit0 = 1（Thumb 指令，Cortex-M 只有 Thumb 模式）
   │    • 对应地址的前一条指令是 BL/BLX（确认是调用点）
   └─ 找到后记录该 LR，继续向上扫描，直到到达栈顶或超出范围

4. 输出结果
   └─ 将收集到的地址序列通过串口打印，格式如：
      fault on thread: main
      addr2line -e firmware.elf -a -f 0x08002abc 0x08001f34 0x08000c12
```

### LR 扫描的可靠性边界

cm_backtrace 采用的是**启发式 LR 扫描**，不是基于 DWARF 调试信息的精确展开，因此存在以下局限：

| 情形 | 影响 |
|------|------|
| 函数内联（`-O2` 及以上）| 内联函数不产生 BL 指令，回溯链中会缺少该层 |
| 尾调用优化（`-O2` tailcall）| 编译器用 B 替换 BL，该帧 LR 不入栈，可能丢帧 |
| 栈已被溢出破坏 | LR 值被覆盖，回溯结果不可信 |
| 代码段地址范围配置错误 | 合法 LR 被过滤掉，或误匹配数据中的值 |

因此 cm_backtrace 的结果应作为**辅助定位线索**，结合出错 PC 和 CFSR/BFAR 等寄存器综合判断。

---

## 3. Lauterbach TRACE32 离线死机分析

### 原理概述

死机分析的本质是：**在设备重启后，用工具在 PC 上重建死机瞬间的完整内存快照**，再由 TRACE32 结合 ELF 符号表还原调用链和变量值。

可按分析需求保存以下区域：

| 区域 | 原因 |
|------|------|
| Stack | 调用链返回地址（LR）和各帧局部变量，是回溯的核心 |
| Heap | 若栈帧中的指针指向堆对象，保存堆后才能还原对象内容 |
| 全局/静态变量区 | 需要分析系统状态、标志位或缓冲区时用于还原上下文 |

栈和异常现场寄存器是调用链分析的核心；若还需要查看堆对象和全局状态，则应同时保存对应 SRAM 区域。直接保存实际使用的 SRAM 地址范围通常最省事，但多 SRAM 区域器件应按链接布局分别处理。

### crash handler 中的保存步骤

```c
void HardFault_Handler(void) {
    __disable_irq();                              /* 关中断，保证快照原子性 */
    save_registers(...);                          /* 保存 R0–R15, xPSR, CFSR 等 */
    memcpy(dump_dst, (void *)0x20000000, SRAM_SIZE); /* 拷贝整块 SRAM */
    mark_dump_valid();                            /* 写魔数标记 dump 有效 */
    while (1);                                    /* 等待复位或人工介入 */
}
```

dump 目标可以是外部 Flash、独立且不会被源数据覆盖的备份 SRAM、SD 卡，也可以通过 UART 输出到上位机。

### TRACE32 加载与分析

```
; 加载 ELF（提供符号表和代码段，不覆盖 SRAM）
Data.LOAD.Elf firmware.elf /NoCODE

; 将保存的 SRAM dump 还原到原始地址
Data.LOAD.Binary sram_dump.bin 0x20000000

; 恢复死机瞬间的寄存器值
Register.Set PC 0x08002abc
Register.Set SP 0x20004f20
; ... 其余寄存器

; 展开调用栈
frame /task /nocode
```

ELF 提供“每个符号在哪、类型是什么”，内存快照提供“每个地址的值是多少”。两者来自同一次构建且现场足够完整时，TRACE32 可以尝试展开调用链、查看栈帧局部变量，并在对应内存区域已保存时解引用指针。

### 注意事项

- **栈溢出场景**：若死机原因本身是栈溢出，栈内 LR 已被覆盖，调用链回溯不可信，只能依赖 PC + CFSR 定位错误类型。
- **关中断保证原子性**：拷贝 SRAM 期间若被中断打断并修改内存，快照将不一致，分析结果失真。

---

## 4. 常见软件缺陷

> 本节只对常见软件缺陷作简要介绍，暂不讨论 RTOS 的任务栈、任务切换、ISR API、断言和系统钩子等 OS 相关问题。各类缺陷的复现方法、寄存器分析和调试案例后续单独整理。

软件缺陷与异常类型并不是固定的一一对应关系。错误访问如果落在有效的 SRAM、Flash 或外设地址范围内，可能不会立即触发 fault，而是先破坏数据，之后才在其他位置表现为异常。

### 4.1 野指针、空指针和悬空指针

指针未初始化、指向已经失效的对象，或被错误运算后指向非法地址，都可能造成无效内存访问。

- M3/M4：可能触发 BusFault；启用 MPU 且违反访问权限时可能触发 MemManage Fault；
- M0/M0+：总线访问失败通常进入 HardFault；
- 如果指针仍落在有效地址范围内，则可能只造成数据破坏，不会立即异常。

排查时主要结合栈帧 PC、故障指令使用的地址寄存器，以及 M3/M4 的 `CFSR`、`BFAR` 和 `MMFAR`。

### 4.2 数组越界与内存踩踏

数组下标越界、缓冲区长度计算错误，或者 `memcpy` 等操作超过目标容量，可能覆盖相邻变量、函数指针或栈帧。

这类问题通常不会在首次越界时立即产生异常，而是在被破坏的数据随后被使用时才暴露，因此最终的异常 PC 不一定是根因位置。

### 4.3 栈溢出与栈帧破坏

调用层次过深、局部变量过大或中断嵌套过多，可能使 MSP/PSP 超出预留范围，并破坏其他数据或函数返回地址。

- M3/M4：配置 MPU 栈保护区后可触发 MemManage Fault，否则可能在数据被破坏后表现为 HardFault；
- M0：没有 MPU，通常无法在越界瞬间拦截；
- M0+：只有芯片实现并正确配置可选 MPU 后，才能建立栈保护区。

常用检查方法包括栈水位填充、编译器栈使用报告，以及核对 MSP/PSP 的实际边界。

### 4.4 非对齐访问

使用半字、字或多字指令访问不满足自然对齐要求的地址，可能产生对齐异常。常见原因是强制转换字节指针、直接访问 `packed` 结构体成员，或把通信字节流直接解释成多字节整数。

- M3/M4：部分普通非对齐访问可以由硬件完成，使能 `CCR.UNALIGN_TRP` 后会触发 UsageFault；部分指令始终要求对齐；
- M0/M0+：ARMv6-M 要求访问自然对齐，违规访问通常进入 HardFault。

### 4.5 整数除零

M3/M4 使用硬件除法指令并使能 `CCR.DIV_0_TRP` 时，整数除零会触发 UsageFault。M0/M0+ 没有硬件除法指令，通常由编译器运行库完成除法；C 语言中的整数除零属于未定义行为，具体表现取决于工具链和运行库。

无论内核是否支持除零陷阱，都应在运算前校验除数。

### 4.6 执行非法指令或跳转到非法地址

函数指针错误、返回地址被覆盖、Thumb 状态位错误或向量表内容异常，都可能使 PC 跳转到无效位置。

- M3/M4：可能表现为 UsageFault、MemManage Fault 或 BusFault；
- M0/M0+：通常汇总到 HardFault。

排查时应确认栈帧中的 PC 是否位于有效代码段，并结合反汇编判断是指令本身非法，还是跳转目标已经损坏。

### 4.7 异常返回现场损坏

Cortex-M 异常返回时，需要根据 LR 中的 EXC_RETURN 选择栈并恢复 PC、xPSR 等寄存器。栈溢出、内存越界或异常处理程序错误修改栈帧，都可能使处理器无法恢复到原来的执行状态。

- M3/M4：可能触发 UsageFault，并置位 `INVPC` 或 `INVSTATE`；异常升级后也可能进入 HardFault；
- M0/M0+：通常进入 HardFault。

排查时应检查 EXC_RETURN、栈帧中的 PC 和 xPSR，以及当前 MSP/PSP 是否仍在有效栈范围内。

### 4.8 简要对比

| 软件缺陷 | M3/M4 可能表现 | M0/M0+ 可能表现 |
|----------|----------------|-----------------|
| 野指针、空指针、悬空指针 | BusFault / MemManage，或静默破坏 | HardFault，或静默破坏 |
| 数组越界、内存踩踏 | 延迟出现的任意 fault | 延迟出现的 HardFault |
| 栈溢出、栈帧破坏 | MemManage（需 MPU）/ HardFault | HardFault；M0+ 可选 MPU |
| 非对齐访问 | UsageFault，部分访问可由硬件完成 | HardFault |
| 整数除零 | UsageFault（硬件除法且需使能） | 取决于编译器运行库 |
| 非法指令或跳转 | UsageFault / MemManage / BusFault | HardFault |
| 异常返回现场损坏 | UsageFault / HardFault | HardFault |

---

## 5. Cortex-M0 / M0+ 异常分类

### 系统异常

| 编号 | 名称 | 说明 |
|------|------|------|
| 1 | Reset | 复位，固定优先级 -3（最高） |
| 2 | NMI | 不可屏蔽中断，固定优先级 -2 |
| 3 | HardFault | 硬错误，固定优先级 -1 |
| 11 | SVCall | 由 SVC 指令触发的系统服务调用 |
| 14 | PendSV | 可挂起的系统服务，常用于上下文切换 |
| 15 | SysTick | 系统节拍定时器（可选实现） |

### 外部中断

外部中断从异常编号 16 开始。Cortex-M0/M0+ 最多支持 32 个外部中断，即异常编号 16～47、IRQ0～IRQ31；具体 MCU 可以只实现其中一部分。

### M0/M0+ 不具备的独立 fault

相比 M3/M4，M0/M0+ 不提供以下可配置 fault：

- **MemManage Fault**：内存保护和访问权限错误；
- **BusFault**：取指或数据访问时的总线错误；
- **UsageFault**：未定义指令、非法状态等用法错误。

ARMv6-M 的 fault 分类更精简，上述错误不会分别进入三个独立处理程序，而通常表现为 HardFault。

### M0 与 M0+ 的差异

M0+ 沿用 M0 的基本异常模型，主要扩展在其他内核能力上：

| 特性 | M0 | M0+ |
|------|----|-----|
| 流水线 | 3 级 | 2 级 |
| MPU | 无 | 可选 8 区域 MPU |
| 指令跟踪 | 无 | 可选 MTB（Micro Trace Buffer） |
| 单周期 I/O | 无 | 支持单周期 I/O 接口 |

即使某个 M0+ 实现了 MPU，ARMv6-M 仍不提供独立的 MemManage、BusFault 和 UsageFault；MPU 访问违规最终由 HardFault 处理。

---

## 6. Cortex-M3 / M4 异常分类

### 系统异常

| 编号 | 异常名称 | 优先级 | 说明 |
|------|----------|--------|------|
| 1 | Reset | -3（最高） | 复位 |
| 2 | NMI | -2 | 不可屏蔽中断 |
| 3 | HardFault | -1 | 硬错误及其他 fault 的升级入口 |
| 4 | MemManage | 可配置 | 内存管理错误 |
| 5 | BusFault | 可配置 | 总线错误 |
| 6 | UsageFault | 可配置 | 用法错误 |
| 7～10 | 保留 | — | — |
| 11 | SVCall | 可配置 | SVC 指令触发的系统服务调用 |
| 12 | DebugMonitor | 可配置 | 调试监控异常 |
| 13 | 保留 | — | — |
| 14 | PendSV | 可配置 | 可挂起的系统服务 |
| 15 | SysTick | 可配置 | 系统节拍定时器 |
| 16～255 | IRQ0～IRQ239 | 可配置 | 最多 240 个外部中断，具体 MCU 可以实现更少 |

### 错误类异常详解

#### HardFault（硬错误）

- MemManage、BusFault 或 UsageFault 未使能，或在其处理过程中再次产生不能处理的 fault 时，可能升级为 HardFault；
- 向量表读取失败也会触发 HardFault；
- 可结合 `HFSR.FORCED`、`HFSR.VECTTBL` 和 CFSR 中的子状态位继续判断来源。

#### MemManage Fault（内存管理错误）

- MPU 访问权限违规；
- 执行 XN（Execute Never）区域中的代码；
- 栈越界进入 MPU 保护区。

#### BusFault（总线错误）

- 取指总线错误；
- 数据读写总线错误；
- 外设或存储器返回错误响应；
- 某些指令对未对齐地址的访问无法完成。

精确数据总线错误通常能由栈帧 PC 定位到相关指令；非精确 BusFault 可能延迟上报，此时栈帧 PC 不一定就是实际出错指令。

#### UsageFault（用法错误）

- 执行未定义指令；
- 使用非法的 EXC_RETURN，或发生非法状态切换；
- 整数除以零（使用硬件除法指令且使能 `DIV_0_TRP`）；
- 未对齐访问（使能 `UNALIGN_TRP`，或指令本身要求对齐）；
- 访问未实现或未使能的协处理器。Cortex-M4 的浮点单元是可选项，未实现或未使能时执行相关指令可置位 `NOCP`；Cortex-M3 不带浮点单元。

### 触发关系概览

```text
MPU 访问违规             -> MemManage Fault
取指或数据总线响应错误   -> BusFault
非法指令或非法状态       -> UsageFault
上述 fault 未使能或升级  -> HardFault
HardFault 处理期间再故障 -> Lockup
```

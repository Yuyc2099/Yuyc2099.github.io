# Cortex-M 内核启动流程解析

<!--
Author: Yuyc2099
Source-Repository: https://github.com/Yuyc2099/Yuyc2099.github.io
Source-ID: yuyc2099:cortex-m-startup-sequence:2026-08-18
-->

## 1. 文档范围

本文结合一个 Cortex-M0+ 工程实例，说明 Cortex-M 内核从芯片复位到进入应用程序的完整过程，重点解析 `__Vectors` 之后的执行路径。复位读取初始栈指针和复位入口、执行 `Reset_Handler`、初始化 C 运行环境等主流程在 Cortex-M 系列中基本一致；Fault 向量、VTOR 支持和外部中断数量等细节以具体内核及芯片为准。

> 本文列出的具体地址来自当前工程的 Map 文件。代码或链接配置变化后，函数和 RAM 地址可能变化，但启动原理不变。

---

## 2. 启动流程总览

```text
芯片上电或复位
    |
    v
CPU 从向量表第 0 项读取 __initial_sp
    |
    v
MSP = 0x200033A0（当前构建）
    |
    v
CPU 从向量表第 1 项读取 Reset_Handler
    |
    v
Reset_Handler
    |
    +-- SystemInit()
    |     +-- 配置 HSI/LSI 校准值
    |     +-- 设置 VTOR = 0x08000000
    |
    +-- 跳转到 Arm C 运行库 __main
          +-- 将 RW/.data 初值从 Flash 复制到 SRAM
          +-- 清零 ZI/.bss
          +-- 初始化 C 运行环境
          +-- 调用用户 main()
                +-- 系统和外设初始化
                +-- 应用模块初始化
                +-- 进入 while (1) 主循环
```

其中，最重要的先后关系是：

```text
SystemInit() 在 .data 复制和 .bss 清零之前执行。
```

因此，`SystemInit()` 不能依赖已经完成初始化的普通可写全局变量。

---

## 3. 启动文件前置配置

### 3.1 栈空间

启动文件为主栈分配 2 KB：

```asm
Stack_Size      EQU     0x00000800

                AREA    STACK, NOINIT, READWRITE, ALIGN=3
Stack_Mem       SPACE   Stack_Size
__initial_sp
```

各指令含义：

- `EQU`：定义汇编常量。
- `AREA STACK`：定义名为 `STACK` 的段。
- `NOINIT`：启动时不为该段装载初值。
- `READWRITE`：该段位于可读写 RAM。
- `ALIGN=3`：按照 `2^3 = 8` 字节对齐。
- `SPACE Stack_Size`：预留 0x800 字节空间。
- `__initial_sp`：栈空间末尾的地址标签。

当前 Map 文件中的实际地址为：

| 符号 | 地址 | 说明 |
|---|---:|---|
| `STACK$$Base` | `0x20002BA0` | 栈空间低地址 |
| `STACK$$Limit` | `0x200033A0` | 栈空间高地址 |
| `__initial_sp` | `0x200033A0` | 复位后的 MSP 初值 |

ARM 栈向低地址增长：

```text
高地址  0x200033A0  <- __initial_sp，复位后的 MSP
                |
                | 栈向下增长
                v
低地址  0x20002BA0  <- Stack_Mem
```

### 3.2 堆空间

启动文件声明了 512 字节堆：

```asm
Heap_Size       EQU     0x00000200

                AREA    HEAP, NOINIT, READWRITE, ALIGN=3
__heap_base
Heap_Mem        SPACE   Heap_Size
__heap_limit
```

当前工程启用了 MicroLIB，且本次链接没有实际引用这个 `HEAP` 段，因此 Map 文件显示该段被移除：

```text
Removing startup.o(HEAP), (512 bytes).
```

如果以后使用动态内存分配，需要重新核对堆配置及最终 Map，而不能只看启动文件中的 `Heap_Size`。

### 3.3 指令集和栈对齐约束

```asm
PRESERVE8
THUMB
```

- `PRESERVE8`：声明代码遵守 8 字节栈对齐约定。
- `THUMB`：后续代码使用 Thumb 指令集。Cortex-M 内核执行 Thumb/Thumb-2 指令，具体指令集能力取决于内核型号。

---

## 4. 向量表 `__Vectors`

### 4.1 向量表为什么在 Flash 起始位置

启动文件将向量表放入只读 `RESET` 段：

```asm
                AREA    RESET, DATA, READONLY
                EXPORT  __Vectors
                EXPORT  __Vectors_End
                EXPORT  __Vectors_Size
```

链接脚本要求 `RESET` 段最先放置：

```text
ER_IROM1 0x08000000 ...
{
    *.o (RESET, +First)
    ...
}
```

所以当前链接结果为：

| 符号或区域 | 地址/大小 |
|---|---:|
| `__Vectors` | `0x08000000` |
| `__Vectors_End` | `0x080000C0` |
| `__Vectors_Size` | `0x000000C0` |

向量表共有：

```text
0xC0 / 4 = 48 项
```

即 16 个 Cortex-M 内核向量和 32 个外部中断向量。

### 4.2 前两个向量决定复位入口

```asm
__Vectors       DCD     __initial_sp
                DCD     Reset_Handler
```

`DCD` 用于在当前位置放置一个 32 位数据。这里保存的是地址，不是待顺序执行的汇编指令。

复位时，Cortex-M 内核硬件自动完成：

1. 读取向量表第 0 项，将其装入主栈指针 MSP。
2. 读取向量表第 1 项，将其装入 PC。
3. 从 `Reset_Handler` 开始执行。

当前构建对应的值为：

```text
vector[0] -> __initial_sp  = 0x200033A0
vector[1] -> Reset_Handler = 0x080000D9
```

`Reset_Handler` 符号值最低位为 1，表示 Thumb 状态；对应的实际指令地址是 `0x080000D8`。这是 Cortex-M 函数地址的正常表示方式。

这两步由 CPU 硬件完成，因此启动代码中看不到显式的“设置 MSP”和“跳转到 Reset_Handler”指令。

### 4.3 内核异常向量

向量表第 0～15 项由 Cortex-M 架构定义。下表是当前 M0+ 实例的内容；其他 Cortex-M 内核可能在保留位置提供 MemManage、BusFault、UsageFault、DebugMonitor 等异常：

| 表项 | 异常 | 启动文件内容 |
|---:|---|---|
| 0 | 初始 MSP | `__initial_sp` |
| 1 | Reset | `Reset_Handler` |
| 2 | NMI | `NMI_Handler` |
| 3 | HardFault | `HardFault_Handler` |
| 4～10 | 保留 | `0` |
| 11 | SVCall | `SVC_Handler` |
| 12～13 | 保留 | `0` |
| 14 | PendSV | `PendSV_Handler` |
| 15 | SysTick | `SysTick_Handler` |

### 4.4 外部中断向量

从向量表第 16 项开始，对应芯片 IRQ0～IRQ31：

```asm
                DCD     WWDG_IRQHandler                ; IRQ0
                DCD     PVD_IRQHandler                 ; IRQ1
                DCD     RTC_IRQHandler                 ; IRQ2
                ...
                DCD     EXTI0_1_IRQHandler             ; IRQ5
                ...
                DCD     USART3_4_IRQHandler            ; IRQ29
                DCD     0                              ; IRQ30 Reserved
                DCD     0                              ; IRQ31 Reserved
```

某个外部中断向量的存放地址为：

```text
向量地址 = VTOR + 4 × (16 + IRQn)
```

例如 `EXTI0_1_IRQn = 5`：

```text
0x08000000 + 4 × (16 + 5) = 0x08000054
```

地址 `0x08000054` 中保存的是 `EXTI0_1_IRQHandler` 的函数地址。

### 4.5 中断发生时 CPU 做什么

当中断满足响应条件时，CPU硬件大致执行：

1. 将 `R0～R3、R12、LR、PC、xPSR` 等现场压入当前栈。
2. 根据异常号或 IRQn 定位向量表项。
3. 从向量表读取处理函数地址并跳转。
4. 执行中断处理函数。
5. 通过异常返回恢复此前保存的现场。

因此，向量表保存的是各异常和中断的入口地址。

### 4.6 向量表大小符号

```asm
__Vectors_End

__Vectors_Size  EQU     __Vectors_End - __Vectors
```

`__Vectors_End` 只是地址标签，不占用额外空间。`__Vectors_Size` 是汇编期计算出的常量。

---

## 5. `Reset_Handler`

启动文件中的复位处理函数为：

```asm
Reset_Handler   PROC
                EXPORT  Reset_Handler [WEAK]
                IMPORT  SystemInit
                IMPORT  __main

                LDR     R0, =SystemInit
                BLX     R0

                LDR     R0, =__main
                BX      R0
                ENDP
```

### 5.1 符号声明

```asm
EXPORT Reset_Handler [WEAK]
IMPORT SystemInit
IMPORT __main
```

- `EXPORT`：向链接器导出符号。
- `[WEAK]`：将符号声明为弱符号，允许同名强符号覆盖。
- `IMPORT`：声明函数在其他目标文件或库中定义。
- `SystemInit`：由工程的 CMSIS 系统文件提供。
- `__main`：由 Arm C 运行库提供，不是用户编写的 `main()`。

### 5.2 调用 `SystemInit()`

```asm
LDR R0, =SystemInit
BLX R0
```

执行含义：

1. 将 `SystemInit` 的函数地址装入 R0。
2. `BLX R0` 跳转到该地址。
3. `BLX` 同时在 LR 中保存返回地址。
4. `SystemInit()` 返回后，继续执行下一条启动代码。

此时 MSP 已由 CPU 初始化，因此普通函数调用可以使用栈。

### 5.3 跳转到 Arm C 运行库

```asm
LDR R0, =__main
BX  R0
```

`BX` 不保存新的返回地址，相当于把后续控制权交给 `__main`。启动代码不期望 `__main` 返回到 `Reset_Handler`。

当前 Map 中：

| 符号 | 地址 |
|---|---:|
| `__main` | `0x080000C1` |
| `Reset_Handler` | `0x080000D9` |

### 5.4 完整启动文件

下面保留本例使用的完整启动汇编。代码默认折叠，点击标题即可展开查看。

{% source file="startup_py32f040exx.s" lang="asm" title="完整启动文件 startup_py32f040exx.s" origin="startup_py32f040exx.s" %}

---

## 6. `SystemInit()` 阶段

工程中的完整实现为：

```c
/**
 * @brief  Setup the microcontroller system.
 *         Initialize the System.
 * @param  none
 * @return none
 */
void SystemInit(void)
{
  /* Set the HSI clock to 8MHz by default */
  /* Set the LSI clock to 32.768KHz by default */
  RCC->ICSCR = (RCC->ICSCR & 0xFE000000) | (0x1 << 13) | ((*(uint32_t *)(0x1fff3208)) & 0x0000FFFF) | ((*(uint32_t *)(0x1fff3348))<<16);

  /* Configure the Vector Table location add offset address ------------------*/
#ifdef VECT_TAB_SRAM
  SCB->VTOR = SRAM_BASE | VECT_TAB_OFFSET; /* Vector Table Relocation in Internal SRAM */
#else
  SCB->VTOR = FLASH_BASE | VECT_TAB_OFFSET; /* Vector Table Relocation in Internal FLASH */
#endif /* VECT_TAB_SRAM */
}
```

### 6.1 时钟校准

`RCC->ICSCR` 的写入使用芯片内部固定地址中的出厂校准数据，将 HSI 配置为默认 8 MHz，并应用 LSI 校准信息。

这个阶段只是建立最基础的系统时钟状态。应用需要的其他时钟、外设时钟和 HAL 配置在后续用户初始化流程中完成。

### 6.2 设置向量表基址

当前配置为：

```c
/* #define VECT_TAB_SRAM */
#define VECT_TAB_OFFSET 0x00
```

所以执行：

```text
SCB->VTOR = FLASH_BASE + VECT_TAB_OFFSET
          = 0x08000000 + 0
          = 0x08000000
```

这与 `__Vectors` 的链接地址一致。

如果以后使用 Bootloader，应用程序不再从 `0x08000000` 开始，就必须同步修改：

- 应用链接地址。
- `VECT_TAB_OFFSET` 或 VTOR 设置。
- Bootloader 跳转应用前使用的 MSP 和复位入口。

否则可能出现复位入口正确，但中断仍跳到错误固件向量表的问题。

### 6.3 此时不能依赖已初始化全局变量

`SystemInit()` 在 `__main` 之前执行，此时：

- 有初值的可写全局变量还没有从 Flash 复制到 RAM。
- 未初始化全局变量对应的 `.bss/ZI` 还没有由 C 运行库清零。
- 栈已经可用。
- Flash 中的只读常量和硬件寄存器可以使用。

如果扩展 `SystemInit()`，应尽量只操作硬件寄存器、立即数、只读常量和局部变量。

---

## 7. Arm C 运行库 `__main`

`__main` 由 Arm 工具链运行库提供，源码不在本工程中。它负责把“可以执行汇编代码”的环境进一步转换成“符合 C 语言约定的运行环境”。

主要过程如下：

```text
__main
    |
    +-- 根据 scatter-loading 信息初始化各执行区域
    |     +-- RW/.data：从 Flash 装载地址复制到 SRAM
    |     +-- ZI/.bss：在 SRAM 中清零
    |
    +-- 初始化 C 运行库
    |
    +-- 执行需要的静态初始化
    |
    +-- 调用用户 main()
```

当前链接脚本定义：

```text
Flash: ER_IROM1  0x08000000  最大 0x0001FC00
RAM:   RW_IRAM1  0x20000000  最大 0x00004000
```

### 7.1 RW/.data 初始化

例如：

```c
uint32_t value = 123;
```

变量运行地址在 SRAM，但初始值 `123` 保存在固件的 Flash 装载映像中。`__main` 在启动时将初始值复制到对应 SRAM 地址。

### 7.2 ZI/.bss 清零

例如：

```c
uint32_t counter;
static uint8_t buffer[128];
```

这些变量不需要在 Flash 中逐字节保存零值。链接器只记录其 RAM 范围，`__main` 在启动时统一清零。

### 7.3 调用用户 `main()`

只有完成上述 C 运行环境初始化后，运行库才调用工程中的：

```c
int main(void)
```

因此，进入 `main()` 时，普通全局变量已经满足 C 语言规定的初始值。

---

## 8. 默认异常和中断处理

### 8.1 内核异常默认实现

启动文件为 NMI、HardFault、SVC、PendSV 和 SysTick 提供了弱定义。例如：

```asm
HardFault_Handler
                PROC
                EXPORT  HardFault_Handler [WEAK]
                B       .
                ENDP
```

`B .` 表示跳转到当前地址，即永久死循环，方便调试器停在异常现场。

如果工程在异常处理源文件中提供同名 C 函数，链接器就会使用强定义替换启动文件中的弱定义。例如：

```c
void SysTick_Handler(void)
{
    HAL_IncTick();
}
```

Map 文件中可以确认向量表最终引用的是启动文件弱定义，还是其他目标文件中的强定义。

### 8.2 外部中断默认实现

启动文件采用多个标签共用一条死循环指令的方式：

```asm
WWDG_IRQHandler
PVD_IRQHandler
RTC_IRQHandler
...
USART3_4_IRQHandler
                B       .
```

如果工程没有提供同名强定义，对应中断一旦触发就会进入这里永久循环。

这也是调试“程序突然卡死”的重要检查点：可能是某个中断已使能，但对应 ISR 没有在工程中实现，或者函数名与向量表不一致。

### 8.3 强符号覆盖弱符号

例如，工程可以实现与向量表同名的外部中断函数：

```c
void EXTI0_1_IRQHandler(void)
{
    /* Handle the interrupt and clear its pending flag. */
}
```

启动文件中的同名符号带有 `[WEAK]`，而 C 文件中的实现是普通强符号，所以最终向量表指向 C 文件中的实现。

规则可以概括为：

```text
工程存在同名强定义 -> 使用工程实现
工程不存在同名强定义 -> 使用启动文件弱定义
```

---

## 9. MicroLIB 下的栈和堆接口

启动文件末尾根据是否定义 `__MICROLIB` 选择不同接口。

### 9.1 使用 MicroLIB

```asm
IF :DEF:__MICROLIB

    EXPORT __initial_sp
    EXPORT __heap_base
    EXPORT __heap_limit
```

MicroLIB 直接通过这些符号获取栈顶和堆边界。

### 9.2 使用完整 Arm C 库

```asm
ELSE

    IMPORT __use_two_region_memory
    EXPORT __user_initial_stackheap
```

此时通过 `__user_initial_stackheap` 返回：

| 寄存器 | 返回内容 |
|---|---|
| R0 | 堆起始地址 |
| R1 | 栈顶地址 |
| R2 | 堆结束地址 |
| R3 | 栈底地址 |

当前工程配置使用 MicroLIB，因此实际采用第一条路径。

---

## 10. 上电启动与中断响应的关系

启动过程和中断处理共用同一张向量表，但用途不同：

```text
复位：
    vector[0] -> 初始化 MSP
    vector[1] -> 进入 Reset_Handler

运行期间发生内核异常：
    vector[异常号] -> 对应异常处理函数

运行期间发生外部 IRQn：
    vector[16 + IRQn] -> 对应外设中断处理函数
```

复位后 CPU 不会依次执行向量表中的函数。除了前两个复位表项，其他表项只有在对应异常或中断发生时才会被读取。

---

## 11. 最终时序总结

```text
[硬件阶段]
芯片复位
    |
    +-- 读取 0x08000000：MSP = __initial_sp
    |
    +-- 读取 0x08000004：PC = Reset_Handler
    v

[启动汇编阶段]
Reset_Handler
    |
    +-- BLX SystemInit
    |     +-- 设置基础时钟校准
    |     +-- 设置 VTOR
    |
    +-- BX __main
    v

[C 运行库阶段]
__main
    |
    +-- 初始化 RW/.data
    +-- 清零 ZI/.bss
    +-- 初始化 C 运行环境
    +-- 调用 main
    v

[应用阶段]
main
    |
    +-- 系统和外设初始化
    +-- 应用模块初始化
    +-- while (1) 主循环
    v

[运行阶段]
发生异常或中断
    |
    +-- CPU 自动保存现场
    +-- 根据 VTOR 和异常号读取向量
    +-- 执行对应 Handler
    +-- 异常返回并恢复现场
```

一句话概括：`__Vectors` 是 CPU 启动和异常分发使用的地址表；复位时硬件先从表中取得栈顶和复位入口，随后 `Reset_Handler` 完成芯片基础初始化并交给 Arm C 运行库，C 环境准备完成后才进入用户 `main()`。

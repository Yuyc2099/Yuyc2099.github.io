# Cortex-M 编译与链接：从源代码到固件镜像

## 1. 阅读范围

这篇文章讨论的是 **Cortex-M 工程的编译、链接与启动流程**，重点是源码如何变成可烧录固件，以及代码和数据怎样进入 Flash、RAM。严格来说，它不是一篇完整的“编译原理”课程：词法分析、语法分析、类型系统和编译器优化算法只做必要介绍。

示例以 Arm GNU Toolchain 为主。Arm Compiler、IAR 等工具链的文件名和语法不同，但预处理、编译、汇编、链接、装载与启动这些核心阶段相通。

## 2. 从源代码到固件

一条典型构建链路可以概括为：

```text
源文件 .c/.cpp
  │
  ├─ 预处理：展开头文件、宏和条件编译
  │      ↓
  │    预处理结果 .i
  │
  ├─ 编译：语法/语义分析、IR、优化、代码生成
  │      ↓
  │    汇编代码 .s
  │
  ├─ 汇编：机器指令、Section、符号和重定位信息
  │      ↓
  │    可重定位目标文件 .o
  │
  └─ 链接：合并 Section、解析符号、完成重定位和内存布局
         ↓
       ELF/AXF 可执行映像
         │
         └─ objcopy → Intel HEX / raw BIN
```

这里的 `.i` 和 `.s` 是方便理解与排查问题的中间结果，正常构建不一定将它们保存到磁盘。GCC 可以按阶段停止：

```bash
# 仅预处理
arm-none-eabi-gcc -E main.c -o main.i

# 编译到汇编
arm-none-eabi-gcc -S -mcpu=cortex-m4 -mthumb main.c -o main.s

# 编译并汇编为目标文件，不链接
arm-none-eabi-gcc -c -mcpu=cortex-m4 -mthumb main.c -o main.o

# 链接为 ELF；实际工程还会加入启动文件、库和其他目标文件
arm-none-eabi-gcc main.o startup.o -T memory.ld -o firmware.elf
```

## 3. 预处理阶段

预处理器处理 `#include`、`#define` 和条件编译：

```c
#if defined(STM32F4)
#define FLASH_BASE 0x08000000U
#elif defined(STM32H7)
#define FLASH_BASE 0x08000000U
#else
#error "Unsupported target"
#endif
```

常见用途包括芯片型号适配、功能裁剪和编译期配置。排查宏展开、头文件包含顺序或条件宏时，`-E` 比直接猜测更可靠。

预处理输出仍是 C/C++ 源码，不包含最终地址，也没有完成类型检查和指令生成。

## 4. 编译与优化

编译器通常经历词法分析、语法分析、语义检查、中间表示（IR）优化和目标代码生成。

### 4.1 词法与语法分析

词法分析先把字符流拆成关键字、标识符、常量和运算符等 Token；语法分析再依据 C/C++ 语法规则构造抽象语法树（AST）。缺少分号、括号不匹配等错误通常在这里被发现。

例如：

```c
result = a + b * c;
```

AST 会保留乘法优先于加法的层级关系，而不是只保存一串文本。这也是编译器能够进行后续类型检查和表达式优化的基础。

### 4.2 语义分析

语义分析检查“语法正确但含义不合法或可疑”的代码，包括：

- 标识符是否已经声明；
- 函数实参与形参是否匹配；
- 赋值、转换和运算的类型是否兼容；
- 控制流是否满足语言约束。

嵌入式项目常见问题包括整数截断、有符号与无符号混用、移位宽度越界，以及把外设地址转换成错误类型。警告选项应作为构建配置的一部分，而不是只依赖默认诊断：

```bash
arm-none-eabi-gcc -Wall -Wextra -Wconversion -Wshadow -c main.c
```

### 4.3 中间表示与优化

GCC 内部会使用 GIMPLE、RTL 等中间表示。IR 把源语言细节转换为更适合分析和变换的形式，使常量传播、死代码删除、循环优化和寄存器分配等过程不必直接操作源码文本。

日常开发更需要关注优化对代码行为和调试体验的影响。

| 优化等级 | 主要目标 | 常见用途 |
|---|---|---|
| `-O0` | 关闭大多数优化，缩短编译时间 | 初期调试、观察源码对应关系 |
| `-Og` | 保留调试体验，同时启用部分优化 | 日常调试版本 |
| `-O1` | 基础速度与体积优化 | 希望控制优化影响时 |
| `-O2` | 启用更多不以明显增大体积换速度的优化 | 常见发布配置 |
| `-O3` | 增加循环、内联等性能优化机会 | 经测量确认的计算热点 |
| `-Os` | 在 `-O2` 基础上偏向代码体积 | Flash 容量敏感的固件 |

具体启用了哪些优化会随 GCC 版本和目标配置变化，可用以下命令查询，而不要只凭优化等级名称推断：

```bash
arm-none-eabi-gcc -O2 -Q --help=optimizers
```

优化可能导致变量不可见、语句重排、函数内联和尾调用，源码断点不再与指令一一对应。这通常不是“编译错了”，而是调试器展示优化后机器代码的结果。

### 4.4 代码生成

代码生成阶段根据目标内核、ABI 和优化结果选择具体指令，安排寄存器并生成汇编表示。以下选项必须与实际目标一致：

```bash
arm-none-eabi-gcc \
  -mcpu=cortex-m4 \
  -mthumb \
  -mfloat-abi=hard \
  -mfpu=fpv4-sp-d16 \
  -S main.c -o main.s
```

若芯片没有启用相应 FPU，或工程中的库采用不同浮点 ABI，上述配置就不能直接使用。

### 4.5 Cortex-M 的指令集差异

Cortex-M 处理器只执行 Thumb 状态的代码，但不同内核支持的指令集合并不完全相同：

- Cortex-M0/M0+ 基于 Armv6-M，主要使用较小的 Thumb 指令子集；
- Cortex-M3 基于 Armv7-M，支持更完整的 Thumb/Thumb-2 指令；
- Cortex-M4 基于 Armv7E-M，在 Cortex-M3 基础上增加 DSP 扩展，并可选配单精度 FPU。

因此不能把某个 Cortex-M4 生成的目标文件直接当作 Cortex-M0 固件使用。`-mcpu`、`-mthumb`、浮点 ABI 和库文件必须与实际内核及芯片配置一致。

## 5. 汇编阶段

汇编器把 `.s` 中的助记符转换为机器指令，并生成可重定位目标文件 `.o`。由于函数和变量的最终地址尚未确定，跨 Section 或跨文件引用通常先记录为重定位项，交给链接器修正。

汇编阶段还会形成：

- 输入 Section 及其属性；
- 本地符号和全局符号；
- 未解析的外部符号；
- 重定位表；
- 可选的调试行号信息。

可以分别检查汇编结果和重定位信息：

```bash
arm-none-eabi-as -mcpu=cortex-m4 -mthumb main.s -o main.o
arm-none-eabi-readelf -r main.o
arm-none-eabi-objdump -dr main.o
```

## 6. 目标文件与 ELF Section

汇编器生成的 `.o` 是可重定位目标文件：它已有机器码和数据，但很多地址仍等待链接器决定。常见输入 Section 包括：

| Section | 常见内容 | 典型属性 |
|---|---|---|
| `.text` | 函数机器码 | 只读、可执行 |
| `.rodata` | 字符串字面量、只读表 | 只读 |
| `.data` | 有非零初始值的全局/静态对象 | 可读写 |
| `.bss` | 零初始化或未显式初始化的全局/静态对象 | 可读写、ELF 中通常为 `NOBITS` |
| `.isr_vector` | 初始栈值与异常/中断入口 | 只读、需固定布局 |

这些名称是工具链和工程的常见约定，不是 C 语言标准强制规定。自动变量也不一定真的进入“栈段”：优化器可能把它放入寄存器、合并，甚至完全消除。

### 6.1 各类对象的典型去向

```c
const uint8_t table[] = {1, 2, 3};  /* 通常进入 .rodata */
uint32_t count = 10;                 /* 通常进入 .data */
uint32_t buffer[256];                /* 通常进入 .bss */
static uint8_t flag = 1;             /* 通常进入 .data */
static uint8_t state;                /* 通常进入 .bss */

void foo(void)
{
    uint32_t local = 0;              /* 栈、寄存器或被优化掉 */
    use_value(local);
}
```

这里使用“通常”是因为最终结果受编译器、优化、链接脚本和属性控制。若要确认某个符号的位置，应查看 ELF 和 MAP，而不是只凭 C 声明推断。

### 6.2 `.data` 与 `.bss` 的区别

`.data` 中对象需要在进入 `main()` 前具有指定初值，因此初始镜像通常保存在 Flash，运行时副本位于 RAM。`.bss` 中对象按 C 运行环境要求初始化为零，ELF 只需记录地址和大小，启动代码统一清零。

```text
Flash 典型占用：代码 + 只读数据 + .data 初始镜像
RAM  静态占用：.data 运行副本 + .bss
```

“`.bss` 不占 Flash”指它不需要与 Section 同等大小的零初始化镜像，并不意味着最终固件完全没有与其有关的元数据或启动代码。

可以直接检查目标文件：

```bash
arm-none-eabi-objdump -h main.o
arm-none-eabi-nm --print-size --size-sort main.o
arm-none-eabi-readelf -S main.o
```

## 7. 链接器做了什么

链接器的主要工作包括：

1. 合并各目标文件和静态库中的输入 Section；
2. 解析跨文件符号引用；
3. 删除未使用代码（启用 `--gc-sections` 时）；
4. 根据链接脚本分配地址；
5. 完成重定位，生成最终 ELF 和 MAP 文件。

### 7.1 一个最小链接脚本

```ld
MEMORY
{
    FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 512K
    RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 128K
}

SECTIONS
{
    .text :
    {
        KEEP(*(.isr_vector))
        *(.text*)
        *(.rodata*)
    } > FLASH

    .data :
    {
        _sdata = .;
        *(.data*)
        _edata = .;
    } > RAM AT > FLASH
    _sidata = LOADADDR(.data);

    .bss (NOLOAD) :
    {
        _sbss = .;
        *(.bss*)
        *(COMMON)
        _ebss = .;
    } > RAM
}
```

`KEEP` 防止链接器垃圾回收时丢弃没有普通代码引用、但处理器必须读取的向量表。`LOADADDR(.data)` 返回 `.data` 的加载地址。

### 7.2 VMA 与 LMA

理解 `.data` 的关键是区分两个地址：

- **VMA（运行地址）**：程序运行时访问该 Section 的地址；
- **LMA（加载地址）**：固件映像中保存初始化内容的地址。

`.data` 的 VMA 位于 RAM，LMA 位于 Flash。链接器为它分配两份空间，启动代码再把初始值从 LMA 复制到 VMA。

```text
Flash： [ .isr_vector ][ .text ][ .rodata ][ .data 初始镜像 ]
                                                │
                                                └── 启动时复制
RAM：                       [ .data 运行区 ][ .bss ][ heap / stack ]
```

`.bss` 在 ELF 中通常是 `NOBITS`，固件不需要保存一份零字节镜像；链接器只记录其地址和大小，启动代码负责清零。

## 8. 启动文件与复位流程

处理器复位时，硬件从向量表读取前两个 32 位字：

1. 第 0 项装入主栈指针 MSP；
2. 第 1 项装入 PC，开始执行 `Reset_Handler`。

链接后的程序入口通常不是 `main()`，而是启动文件中的 `Reset_Handler`。启动文件一般由芯片厂商提供，例如 `startup_stm32f407xx.s`。典型流程是：

```text
复位
  ├─ 硬件加载 MSP 与 Reset_Handler 地址
  └─ Reset_Handler
       ├─ 将 .data 从 Flash 复制到 RAM
       ├─ 将 .bss 清零
       ├─ 调用 SystemInit()
       ├─ 初始化 C/C++ 运行库
       └─ 调用 main()
```

`SystemInit()`、数据复制和运行库入口的具体先后顺序由芯片厂商启动文件和工具链决定。分析某个工程时，应直接查看它实际链接的 startup 文件。

### 8.1 典型启动文件片段（GCC 汇编风格）

下面保留原文结构。示例用于说明流程，具体指令和运行库入口以实际启动文件为准：

```asm
    .section .text.Reset_Handler
    .weak Reset_Handler
Reset_Handler:
    /* 1. 复制 .data：Flash 加载地址 → RAM 运行地址 */
    ldr   r0, =_sdata       /* RAM 目标起始地址 */
    ldr   r1, =_edata       /* RAM 目标结束地址 */
    ldr   r2, =_sidata      /* Flash 中 .data 的加载地址 */
copy_loop:
    cmp   r0, r1
    ittt  lt
    ldrlt r3, [r2], #4
    strlt r3, [r0], #4
    blt   copy_loop

    /* 2. 清零 .bss */
    ldr   r0, =_sbss
    ldr   r1, =_ebss
    mov   r2, #0
zero_loop:
    cmp   r0, r1
    itt   lt
    strlt r2, [r0], #4
    blt   zero_loop

    /* 3. 系统、C/C++ 运行库和 main */
    bl    SystemInit
    bl    __libc_init_array
    bl    main
infinite_loop:
    b     infinite_loop
```

全局变量的初始值需要保存在 Flash，但对象运行时需要位于可写 RAM。链接脚本用 `> RAM AT > FLASH` 分别指定运行地址和加载地址，启动文件负责复制：

```text
Flash：[ .text ][ .rodata ][ .data 初始值 ]
                                  │
                                  └── 启动时复制
RAM：                   [ .data ][ .bss ][ 堆 ][ ... ][ 栈 ]
```

## 9. 向量表与弱符号

向量表是 Cortex-M 的硬件机制，由一组 32 位表项组成。第一项是 MSP 初始值，后续项目是异常和中断处理函数地址。

| 偏移 | Cortex-M3/M4 常见含义 |
|---|---|
| `0x00` | MSP 初始值 |
| `0x04` | `Reset_Handler` |
| `0x08` | `NMI_Handler` |
| `0x0C` | `HardFault_Handler` |
| `0x10` | `MemManage_Handler` |
| `0x14` | `BusFault_Handler` |
| `0x18` | `UsageFault_Handler` |
| `0x2C` | `SVC_Handler` |
| `0x30` | `DebugMon_Handler` |
| `0x38` | `PendSV_Handler` |
| `0x3C` | `SysTick_Handler` |
| `0x40` 起 | 芯片相关外部中断 IRQ |

Cortex-M0/M0+ 的可配置 Fault 和调试异常集合更少，相应位置可能保留。外部 IRQ 的数量与顺序必须以具体芯片头文件和参考手册为准。

**向量表在启动文件中的定义（C 风格）：**

```c
typedef void (*isr_t)(void);

/* 链接器将 .isr_vector 放到固件向量表起始位置。 */
__attribute__((section(".isr_vector"), used))
const isr_t vector_table[] = {
    (isr_t)&_estack,        /* 0x00: MSP 初始值 */
    Reset_Handler,          /* 0x04: 复位 */
    NMI_Handler,            /* 0x08: NMI */
    HardFault_Handler,      /* 0x0C: HardFault */
    MemManage_Handler,      /* 0x10: MemManage */
    BusFault_Handler,       /* 0x14: BusFault */
    UsageFault_Handler,     /* 0x18: UsageFault */
    0, 0, 0, 0,             /* 0x1C~0x28: 保留 */
    SVC_Handler,            /* 0x2C: SVC */
    DebugMon_Handler,       /* 0x30: DebugMon */
    0,                      /* 0x34: 保留 */
    PendSV_Handler,         /* 0x38: PendSV */
    SysTick_Handler,        /* 0x3C: SysTick */
    WWDG_IRQHandler,        /* 0x40: STM32F4 IRQ0 */
    /* ... IRQ1~IRQ5 ... */
    EXTI0_IRQHandler,       /* STM32F4 IRQ6 */
    /* ... 其余外设中断 ... */
};
```

把 `_estack` 转为 `isr_t` 是启动文件中常见的工具链写法，用于让“栈初值”和“函数地址”共用同一张 32 位表；它不表示第一项真的是可调用函数。

启动文件通常把中断处理函数定义为弱符号。用户提供同名强定义后，链接器会选择用户实现，无需修改启动文件：

```c
/* 启动文件：弱定义，默认死循环。 */
__attribute__((weak))
void EXTI0_IRQHandler(void)
{
    for (;;) {
    }
}

/* 用户代码：同名强定义覆盖弱定义。 */
void EXTI0_IRQHandler(void)
{
    /* 处理 EXTI0 中断 */
}
```

### 9.1 向量表重定位

Cortex-M3/M4/M7 支持通过 `SCB->VTOR` 把向量表重定向到 RAM 或 Flash 的其他位置，常用于：

- 把向量表复制到 RAM 后，运行时修改中断入口。
- 应用不位于默认 Flash 起始地址时，在自身启动阶段激活应用向量表。

Cortex-M0 通常没有 VTOR；其他 M-profile 内核也要检查具体实现。向量表地址还必须满足相应的对齐要求。

### 9.2 ARMCC5 IAP 直接跳转示例

下面这个 STM32 工程示例没有在 Bootloader 中重设 VTOR。它检查应用向量表第一项是否像有效 SRAM 地址，读取第二项复位入口，切换 MSP 后直接跳转：

```c
typedef void (*iapfun)(void);

static iapfun jump2app;
void MSR_MSP(uint32_t addr);

/* appxaddr：用户代码起始地址。 */
void iap_load_app(uint32_t appxaddr)
{
    uint32_t app_msp = *(volatile uint32_t *)appxaddr;

    /* 检查初始 MSP 是否位于该工程允许的 SRAM 地址范围。 */
    if ((app_msp & 0x2FF00000U) == 0x20000000U) {
        /* 向量表第二项是应用 Reset_Handler 地址。 */
        jump2app = (iapfun)*(volatile uint32_t *)(appxaddr + 4U);

        /* 向量表第一项是应用 MSP 初始值。 */
        MSR_MSP(app_msp);

        /* 直接跳转，正常情况下不再返回。 */
        jump2app();
    }
}
```

`MSR_MSP()` 使用 ARMCC5 的 `__asm` 函数语法：

```asm
; addr 通过 r0 传入。
__asm void MSR_MSP(uint32_t addr)
{
    MSR MSP, r0
    BX  r14
}
```

这个模式的职责划分是：

1. Bootloader 设置应用 MSP，并跳到应用 `Reset_Handler`；
2. 应用必须链接到 `appxaddr`；
3. 应用在自己的启动流程中设置 `SCB->VTOR`，例如通过 `SystemInit()` 中的向量表偏移配置，并且要在启用中断前完成。

因此，跳转代码中没有 VTOR 写入并不是遗漏。而是采用“加载程序设置 MSP 并跳转，应用程序主动激活自己的向量表”的划分。`0x2FF00000` 掩码只是该工程针对 SRAM 地址的简化检查，不等同于完整的固件有效性校验；换芯片后要按实际 RAM 范围调整。ARMCC5 的 `__asm void` 语法也不能直接用于 GCC 或 ARMclang。

## 10. `volatile` 能保证什么

`volatile` 告诉编译器：每次抽象机可观察的访问都必须真正发生，不能把值长期缓存于寄存器或删除访问。它适合声明内存映射寄存器，以及被中断和主流程共同观察的简单标志：

```c
#define STATUS_REG (*(volatile uint32_t *)0x40020010U)

/* 原文的指针写法：const 约束指针本身，volatile 约束寄存器访问。 */
volatile uint32_t *const GPIOA_IDR =
    (volatile uint32_t *)0x40020010U;
```

但 `volatile` **不保证**：

- 复合操作具有原子性；
- 多核或 DMA 访问顺序；
- 自动插入内存屏障；
- 消除 C 语言中的数据竞争。

对外设寄存器还要遵守访问宽度、只写、读清零、写 1 清零等硬件规则。

## 11. 编译器属性与内联汇编

### 11.1 常用 GCC `__attribute__`

原文列出的属性补回并增加适用边界：

```c
/* 把对象放入自定义输入 Section。 */
__attribute__((section(".ccmram")))
uint32_t sample_buffer[256];

/* 防止符号因“未引用”被编译器删除；链接阶段仍可能需要 KEEP。 */
__attribute__((used))
const uint32_t image_marker = 0x12345678U;

/* 禁止函数内联，便于观测调用边界。 */
__attribute__((noinline))
void trace_point(void) { }

/* always_inline 通常应与 inline 同用，优化和调用条件仍会影响结果。 */
static inline __attribute__((always_inline))
uint32_t read_status(void) { return STATUS_REG; }

/* 取消结构体成员间的常规填充；可能产生非对齐访问。 */
struct __attribute__((packed)) packet_header {
    uint8_t type;
    uint32_t length;
};

/* GCC 支持的函数级优化属性，不属于可移植 C。 */
__attribute__((optimize("O0"), noinline))
void debug_only_function(void) { }
```

`packed` 不只是“节省空间”：在不支持非对齐访问的内核或总线上，直接访问压缩成员可能触发 Fault，编译器也可能生成多个字节访问。协议解析时应结合 `memcpy`、对齐和目标架构检查。

### 11.2 内联汇编

原文用内联汇编开关全局中断：

```c
__asm volatile ("cpsid i" : : : "memory");  /* 屏蔽可配置中断 */
__asm volatile ("cpsie i" : : : "memory");  /* 重新允许可配置中断 */
```

`volatile` 防止该汇编被当作无用代码删除，`"memory"` clobber 告诉编译器不要把周围的普通内存访问任意跨越这段汇编重排。它不是处理器级数据同步屏障；需要顺序保证时还要按场景使用 `DMB`、`DSB` 或 `ISB`。

若工程已使用 CMSIS，优先采用 `__disable_irq()`、`__enable_irq()` 等内建接口，可减少编译器语法差异。进入临界区前还应考虑保存并恢复原 PRIMASK，而不是无条件重新开中断。

## 12. 自定义 Section

自定义 Section 需要源码属性与链接脚本同时配合。

### 12.1 只读数据留在 Flash

```c
__attribute__((section(".firmware_info"), used))
const char firmware_version[] = "v1.2.3";
```

```ld
.firmware_info :
{
    . = ALIGN(4);
    KEEP(*(.firmware_info))
    . = ALIGN(4);
} > FLASH
```

### 12.2 代码从 Flash 复制到 RAM 执行

```c
__attribute__((section(".ramfunc"), noinline))
void flash_write_page(uint32_t address, const uint8_t *buffer)
{
    /* Flash 编程实现由具体芯片决定。 */
    program_flash_words(address, buffer);
}
```

```ld
.ramfunc :
{
    _sramfunc = .;
    *(.ramfunc*)
    _eramfunc = .;
} > RAM AT > FLASH
_siramfunc = LOADADDR(.ramfunc);
```

启动代码必须像复制 `.data` 一样复制 `.ramfunc`。函数依赖的常量、跳转表和被调用函数是否也可在目标 RAM 执行，需要结合反汇编确认。

### 12.3 STM32F4 CCM RAM 示例

原文使用 STM32F4 的 CCM RAM 说明“Flash 保存初值、特定 RAM 运行”的变量 Section。CCM RAM 连接在 Cortex-M4 的专用数据路径上，常见 STM32F4 实现中不能被 DMA 访问，因此缓冲区放置前必须核对具体器件的总线结构。

```c
/* 非零初始化保证示例明确需要 Flash 初始镜像。 */
__attribute__((section(".ccmram")))
uint32_t dsp_buffer[256] = {1U};
```

```ld
MEMORY
{
    FLASH  (rx)  : ORIGIN = 0x08000000, LENGTH = 512K
    RAM    (rwx) : ORIGIN = 0x20000000, LENGTH = 128K
    CCMRAM (rwx) : ORIGIN = 0x10000000, LENGTH = 64K
}

SECTIONS
{
    .ccmram :
    {
        . = ALIGN(4);
        _sccmram = .;
        *(.ccmram*)
        . = ALIGN(4);
        _eccmram = .;
    } > CCMRAM AT > FLASH
    _siccmram = LOADADDR(.ccmram);
}
```

启动代码需要增加一段复制逻辑：

```c
extern uint32_t _sccmram, _eccmram, _siccmram;

static void copy_ccmram(void)
{
    uint32_t *dst = &_sccmram;
    const uint32_t *src = &_siccmram;

    while (dst < &_eccmram) {
        *dst++ = *src++;
    }
}
```

原文同时给出了 `.ramfunc` 的复制代码，逻辑完全相同：

```c
extern uint32_t _sramfunc, _eramfunc, _siramfunc;

static void copy_ramfunc(void)
{
    uint32_t *dst = &_sramfunc;
    const uint32_t *src = &_siramfunc;

    while (dst < &_eramfunc) {
        *dst++ = *src++;
    }
}
```

如果 CCM 中的数据不需要初值，应另建 `NOLOAD` Section，并在需要时由软件清零；不要让“有初值复制”和“不初始化保留”共用同一个输出 Section。

### 12.4 不初始化的 RAM 数据

```c
__attribute__((section(".noinit")))
uint32_t reset_reason;
```

```ld
.noinit (NOLOAD) :
{
    . = ALIGN(4);
    *(.noinit*)
    . = ALIGN(4);
} > RAM
```

`.noinit` 只表示启动代码不主动初始化它。RAM 能否跨某类复位保留，仍取决于芯片复位域、供电、ECC 初始化、Bootloader 和启动代码，不能假设掉电后仍有效。

### 12.5 三种自定义 Section 模式对比

| 模式 | Flash 占用 | RAM 占用 | 启动时操作 | 典型用途 |
|---|---:|---:|---|---|
| 只在 Flash | 有 | 无 | 无 | 只读表、版本与构建信息 |
| Flash → RAM | 有 | 有 | 复制 | `.ramfunc`、有初值的专用 RAM 数据 |
| 只在 RAM、`NOLOAD` | 无初始镜像 | 有 | 按设计跳过 | 复位记录、Bootloader 交接区 |

这个表描述的是常见固件映像关系。ELF 头、对齐填充和烧录格式仍可能带来少量额外空间，精确值应以 Section 和 Program Header 为准。

## 13. C 程序的典型内存分区

原文把运行时内存归纳为代码、只读数据、全局/静态数据、堆和栈。这个模型适合入门，但它不是 C 标准规定的固定物理布局；Cortex-M 工程的真实地址、增长方向和预留大小由链接脚本、启动代码、C 库及 RTOS 决定。

### 13.1 五类区域总览

下面是常见 MCU 链接布局的概念图，不表示所有芯片都按同一地址顺序排列：

```text
Flash
┌─────────────────────────┐
│ 向量表 / .text          │  机器指令与异常入口
├─────────────────────────┤
│ .rodata                 │  字符串、只读表
├─────────────────────────┤
│ .data 的加载镜像（LMA） │  RAM 变量的初值
└─────────────────────────┘

RAM
┌─────────────────────────┐  低地址
│ .data（VMA）            │  有初值的全局/静态对象
├─────────────────────────┤
│ .bss                    │  启动时清零
├─────────────────────────┤
│ heap                    │  常见实现向高地址增长
│            ↑            │
│        未分配空间       │
│            ↓            │
│ stack                   │  Cortex-M 常见实现向低地址增长
└─────────────────────────┘  高地址
```

| 区域 | 常见存储位置 | 生命周期/管理方式 | 典型内容 |
|---|---|---|---|
| 代码 `.text` | Flash | 固件运行期间 | 函数机器码 |
| 只读数据 `.rodata` | Flash | 固件运行期间 | 常量表、字符串字面量 |
| `.data` | Flash 保存初值，RAM 运行 | 固件运行期间 | 有初值的全局和静态对象 |
| `.bss` | RAM | 固件运行期间 | 零初始化的全局和静态对象 |
| heap | RAM | 分配器管理 | `malloc`/`free` 对象 |
| stack | RAM | 调用约定、编译器和 RTOS 管理 | 调用帧、保存寄存器、部分局部对象 |

### 13.2 变量存放位置速查

```c
int g_a = 10;                /* 通常为 .data */
int g_b;                     /* 通常为 .bss */
const int g_c = 100;         /* 通常为 .rodata */
const char *p = "hello";    /* p 通常在 .data，字面量在 .rodata */

void foo(void)
{
    int local = 0;           /* 栈、寄存器或被优化掉 */
    static int s = 1;        /* 通常为 .data */
    static int t;            /* 通常为 .bss */
    int *heap = malloc(sizeof(*heap));

    if (heap != NULL) {
        *heap = local;
        free(heap);
    }
}
```

局部 `static` 对象具有静态存储期，并不会因为写在函数内部就进入线程栈。字符串字面量不可修改，所以示例使用 `const char *`。

### 13.3 Cortex-M 与桌面程序的常见差异

| 维度 | 桌面 OS 进程 | 常见 Cortex-M 裸机/RTOS |
|---|---|---|
| 地址空间 | 通常有虚拟内存和进程隔离 | 通常没有 MMU，部分内核可用 MPU |
| 堆 | 受进程地址空间、提交限制和分配器约束 | 直接受有限 RAM 与分配器配置约束 |
| 栈 | OS 为线程分配并可提供保护页 | 链接脚本或 RTOS 为每个上下文预留固定区域 |
| 越界后果 | 常见结果是页故障或进程终止 | 可能触发 Fault，也可能静默破坏相邻数据 |
| `.data` 初始化 | 由程序装载器和运行库处理 | 通常由 `Reset_Handler`/运行库启动代码处理 |
| 固件映像 | OS 根据 ELF/PE 段装载 | 烧录工具按 HEX/ELF 地址或指定 BIN 基址写 Flash |

“桌面堆几乎无限”并不准确；它仍受虚拟地址空间、物理内存、提交限制和系统策略约束。嵌入式的主要区别是容量与失败模式更直接、更可预测。

### 13.4 嵌入式内存实践

- 在长期运行系统中谨慎使用通用动态分配，评估碎片和最坏情况耗时；
- 每次分配都检查 `NULL`，并明确对象所有权；
- 通过链接 MAP、RTOS 高水位或填充字检测栈余量；
- 对关键区域配置 MPU 保护（内核和芯片支持时）；
- 区分“静态 RAM 占用”和“运行时峰值”，不要只看 `data + bss`。

## 14. Flash 与 RAM 占用

`arm-none-eabi-size` 的 Berkeley 风格输出常见为：

```text
   text    data     bss     dec     hex filename
  32768    1024    4096   37888    9400 firmware.elf
```

可用下面的近似关系快速估算：

```text
Flash 初始化映像 ≈ text + data
RAM 静态占用     ≈ data + bss
```

其中 `text` 不只等于名为 `.text` 的 Section，通常还汇总只读代码和数据；实际归类由 ELF Section 决定。堆、栈、对齐空洞、保留区和某些 `NOLOAD` Section 也不一定完整反映在这三个数字中。

需要精确分析时，结合 MAP 和 Section 表：

```bash
arm-none-eabi-size -A firmware.elf
arm-none-eabi-objdump -h firmware.elf
arm-none-eabi-objdump -d -j .text firmware.elf
arm-none-eabi-readelf -lS firmware.elf
arm-none-eabi-nm --print-size --size-sort firmware.elf
```

## 15. ELF、HEX 与 BIN

| 格式 | 特点 | 常见用途 |
|---|---|---|
| ELF/AXF | 包含 Section、符号、重定位结果及可选调试信息 | 调试、反汇编、分析 |
| Intel HEX | 文本记录中带目标地址和校验信息 | 烧录、升级文件 |
| BIN | 只有连续原始字节，不自带加载地址 | 固定地址烧录、Bootloader 升级 |

链接器通常先生成 ELF，再由 `objcopy` 导出烧录格式：

```bash
arm-none-eabi-objcopy -O ihex firmware.elf firmware.hex
arm-none-eabi-objcopy -O binary firmware.elf firmware.bin
```

BIN 不携带目标地址。如果 ELF 中存在相距很远的多个加载区域，导出 BIN 时还要检查填充、分区和烧录地址，不能只看文件大小。

## 16. 编译阶段与产物速查

原文最后的流程表补回如下，并明确 `.i`、`.s` 通常只是按需保留的中间产物：

| 阶段 | GNU 工具/驱动 | 主要产物 | 常用检查方式 |
|---|---|---|---|
| 预处理 | `cpp` / `gcc -E` | `.i` 预处理源码 | 检查宏和头文件展开 |
| 编译 | `cc1` / `gcc -S` | `.s` 汇编代码 | 阅读指令选择与优化结果 |
| 汇编 | `as` / `gcc -c` | `.o` 可重定位目标文件 | `readelf -rS`、`objdump -dr` |
| 链接 | `ld` / `gcc` 驱动 | ELF/AXF、MAP | 符号、Section、VMA/LMA |
| 格式转换 | `objcopy` | HEX / BIN | 核对地址范围与镜像内容 |

实际工程通常用 `gcc` 驱动统一调用编译器、汇编器和链接器，因为它还能自动传递目标选项并选择运行库。直接调用 `ld` 时，启动文件、库路径和 ABI 必须由构建系统完整提供。

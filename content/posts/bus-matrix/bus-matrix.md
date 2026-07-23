# STM32F4 总线架构：Cortex-M4、AHB 与 APB

## 1. 阅读范围与边界

本文以 **STM32F4 系列常见的 Cortex-M4 系统架构**为主线，解释内核总线接口、片上 Bus Matrix、Flash 访问、DMA，以及 AHB 与 APB 之间的关系。

需要先区分两个层级：

- **Cortex-M4 内核定义**：ICode、DCode、System 等接口，以及地址空间如何路由到这些接口。
- **STM32F4 芯片实现**：Bus Matrix 拓扑、Flash 加速器、DMA 路径、SRAM 分区与外设挂载位置。

STM32F4 包含多个子系列，它们的主设备数量、SRAM 分区、DMA 能力和时钟树并不完全相同。本文描述共同原理；涉及具体路径、寄存器或最坏延迟时，应以所用芯片的 Reference Manual 为准。

> **M0/M3 差异：** Cortex-M0 使用单一 AHB-Lite 接口，取指和数据访问不具备 M3/M4 的三接口结构；Cortex-M3 与 M4 都具有 ICode、DCode 和 System 接口。M4 相比 M3 主要增加 DSP 指令和可选 FPU，总线接口基本一致。

## 2. 从 Cortex-M4 接口到 STM32F4 总线矩阵

### 2.1 Cortex-M4 的四类接口

Cortex-M4 对外提供三个 32-bit AHB-Lite 接口，并为内核私有外设提供 PPB 接口：

| 接口 | 主要用途 | 典型地址区域 |
|------|----------|--------------|
| ICode | Code 区取指、位于 Code 区的向量读取 | `0x00000000~0x1FFFFFFF` |
| DCode | Code 区的数据读取、literal load、调试访问 | `0x00000000~0x1FFFFFFF` |
| System | SRAM、外设、外部存储器访问，以及从这些区域取指 | `0x20000000~0xDFFFFFFF`、部分高地址区域 |
| PPB | NVIC、SysTick、SCB、调试组件等内核私有外设 | `0xE0000000` 附近的 PPB 区域 |

ICode 和 DCode 虽然访问相同的 Code 地址区，却是两条独立接口：取指通常走 ICode，程序读取 Flash 中的常量通常走 DCode。访问 SRAM 或普通外设时，则使用 System 接口。

```text
                         Cortex-M4
                 ┌─────────────────────┐
Code 区取指  ◄────│ ICode               │
Code 区数据  ◄────│ DCode               │
SRAM/外设    ◄────│ System              │
NVIC/SCB     ◄────│ PPB                 │
                 └─────────────────────┘
```

接口由访问地址和访问类型决定，不是由编译器直接“选择总线”。链接脚本通过决定代码和数据的地址，间接决定最终使用哪条接口。

> **M0/M3 差异：** M0 没有独立的 ICode 和 DCode，因此不能直接套用“I-Code 与 D-Code 并行访问”的分析；M3 与 M4 在这一点上基本相同。

### 2.2 Bus Matrix 属于芯片实现

Cortex-M4 提供接口，但不规定 MCU 必须采用哪一种片上互联。STM32F4 通常使用多层 AHB Bus Matrix，把多个主设备连接到多个从设备。

```text
主设备                         Bus Matrix                  从设备
─────────────────            ────────────              ───────────────
Cortex-M4 ICode  ───────────►                            Flash 接口
Cortex-M4 DCode  ───────────►                            SRAM
Cortex-M4 System ───────────►   多层 AHB 互联   ───────► AHB 外设
DMA memory port  ───────────►                            AHB-APB Bridge
其他总线主设备   ───────────►                            外部存储接口
```

Bus Matrix 的价值是：多个主设备访问**不同从设备**时，可以并发传输。例如 CPU 从 Flash 取指，同时 DMA 向某块 SRAM 写数据，两条路径可能并行。

如果多个主设备同时请求**同一个从设备**，对应的仲裁器必须决定先后顺序。并发能力因此取决于完整路径，而不能只看“CPU 和 DMA 是否同时工作”。

## 3. AHB-Lite 访问与仲裁

### 3.1 AHB-Lite 的基本传输

AHB-Lite 把地址/控制相位与数据相位分开，连续传输时可以形成流水：

```text
周期             1              2              3
地址相位       地址 A          地址 B          地址 C
数据相位         -             数据 A          数据 B
```

当目标尚未完成当前传输时，可以通过 `HREADY` 延长传输；错误响应通过 `HRESP` 返回。等待主要阻塞发起该访问的主设备路径，不代表整颗芯片上的所有主设备都必须停下。

### 3.2 谁决定优先级

AHB-Lite 接口本身不替 STM32F4 规定 CPU、DMA 和其他主设备的全局优先级。仲裁策略由芯片内部的 Bus Matrix、Bridge 和 DMA 控制器分别实现。

需要区分两层优先级：

1. **DMA 控制器内部优先级**：决定同一 DMA 控制器内多个 stream/request 的服务顺序，通常可由软件配置。
2. **Bus Matrix 仲裁**：决定 CPU、DMA 等主设备竞争同一个从设备时的先后，通常不能通过 HAL 的 DMA priority 配置改变。

ST 的 DMA 应用笔记 AN4031 对其覆盖的 STM32F2/F4/F7 架构描述了 round-robin 仲裁，并给出了并发访问和最坏延迟的分析方法。但具体芯片仍应以对应 Reference Manual 为准，不应写成固定的 `ICode > DCode > DMA1 > DMA2` 优先级链。

### 3.3 竞争发生在哪里

| 同时发生的访问 | 是否一定竞争 | 原因 |
|----------------|--------------|------|
| CPU 从 Flash 取指，DMA 写 SRAM | 不一定 | 目标从设备不同，可能并行 |
| CPU 与 DMA 同时访问同一 SRAM | 会产生仲裁 | 请求汇聚到同一个 SRAM 从端口 |
| ICode 取指与 DCode 读取 Flash 常量 | 可能竞争 | 最终都需要 Flash 接口服务 |
| 两个 DMA stream 使用同一 DMA 控制器 | 可能竞争 | 先经过 DMA 内部仲裁，还可能继续竞争总线 |
| CPU 与 DMA 同时访问 APB | 取决于 Bridge 路径 | APB 事务最终需要由 Bridge 串行执行 |

“使用了 DMA”不等于“CPU 一定更快”。DMA 可以释放 CPU 指令执行时间，但仍然消耗存储器、Bridge 和总线带宽。

## 4. Flash 取指、常量访问与 ART

### 4.1 ICode 和 DCode 如何共享 Flash

程序通常位于 Flash 的 Code 区：

- CPU 取指使用 ICode。
- 读取 Flash 中的 `const`、字符串或 literal pool，通常使用 DCode。
- 向量表位于 Code 区时，异常向量读取使用 ICode；向量表重定位到 SRAM 后，读取改走 System 接口。

ICode 和 DCode 是独立接口，但它们可能汇聚到同一个 Flash 存储系统。两者是否真正并行、谁先完成、需要多少等待周期，取决于 STM32F4 的 Flash 接口和加速机制。

### 4.2 ART 是 STM32F4 的实现，不是 M4 内核缓存

Cortex-M4 内核本身没有架构级 L1 I-Cache/D-Cache。STM32F4 在 Flash 前加入 ART Accelerator，通过宽 Flash 读取、预取和分支相关的缓存机制降低取指等待。

典型 STM32F4 的 Flash 接口一次可取得较宽的指令行，因此不能把“Flash 配置为 5 wait states”简单理解成“每执行一条指令都等待 5 个 CPU 周期”。顺序代码、跳转代码、常量读取和缓存命中的表现都不同。

> **M0/M3 差异：** M0 和 M3 内核同样不自带 Cortex-M7 那样的 L1 Cache。具体 MCU 是否具有 Flash Prefetch、厂商缓存或其他加速器，与采用 M0、M3 还是 M4 不能直接画等号。

### 4.3 DMA 访问 Flash 时

当某个 DMA 路径支持从 Flash 读取数据时，DMA 与 CPU 取指可能共享 Flash 带宽。影响大小取决于：

- DMA 是否连续请求以及传输宽度、burst/FIFO 配置。
- CPU 的取指和常量读取是否命中 Flash 加速器。
- Flash、SRAM 和 DMA 在该芯片上的实际连接路径。
- 是否还有其他主设备同时访问相同目标。

因此不能使用“中断延迟 = Flash wait state + DMA burst 剩余时间”这样的固定公式。对实时路径，应在目标芯片、目标频率和真实 DMA 负载下测量。

### 4.4 常见优化方向

| 方法 | 可能收益 | 需要注意 |
|------|----------|----------|
| 正确配置 Flash latency 与加速器 | 降低常见取指等待 | 必须符合电压和频率条件 |
| 把 DMA 源数据放到 DMA 可访问的 SRAM | 避免 DMA 读取 Flash | 占用 SRAM，并可能转为 SRAM 竞争 |
| 把时间敏感函数放入可执行 SRAM | 避免从 Flash 取指 | 取指改走 System 接口，可能与 DMA 竞争 SRAM |
| 让高带宽任务使用不同 SRAM 从设备 | 增加并发机会 | 取决于具体芯片的 SRAM 分区和连接 |
| 调整 DMA stream、FIFO 和 burst | 平衡延迟与吞吐量 | 需要结合外设实时要求 |

把代码放入 SRAM 并不是只加一个属性就能完成：链接脚本需要设置运行地址和加载地址，启动代码还要把函数从 Flash 复制到目标 SRAM。

```c
__attribute__((section(".ramfunc")))
void time_critical_handler(void) {
    /* 链接脚本和启动复制逻辑必须同时配置 */
}
```

部分 STM32F4 带有 CCM data RAM。它通常不在主 Bus Matrix 中，DMA 不能像访问普通 SRAM 那样访问它，也不能在未查手册的情况下假定它适合作为可执行代码区或 DMA buffer。

## 5. AHB 与 APB 如何协同

### 5.1 APB 本身没有多主仲裁

APB 面向低带宽、低功耗寄存器外设。对 APB 协议来说，Bridge 是主接口，选中的外设是从接口，一次执行一笔事务。

标准 APB 访问至少包含两个 PCLK 周期：

```text
                 Setup                 Access
PSEL               1                      1
PENABLE             0                      1
地址/控制          建立                   保持
PREADY              -                 1 时完成
```

如果外设通过 `PREADY` 插入等待，Access phase 会继续延长。这里的“两周期”是 APB 时钟周期，不能直接写成两个 CPU 周期；还要考虑 HCLK/PCLK 比例和 Bridge 开销。

### 5.2 Bridge 上仍可能存在竞争

“APB 协议没有多主仲裁”不等于“STM32F4 的 APB 路径不存在竞争”。部分 STM32F4 的 AHB-to-APB Bridge 具有来自 Bus Matrix 和 DMA direct path 的多个上游入口，因此 Bridge 自身需要仲裁 CPU 与 DMA 请求。

```text
CPU/System ──► Bus Matrix ──►┐
                             ├──► AHB-to-APB Bridge ──► APB 外设
DMA direct path ────────────►┘
```

Bridge 正在完成 APB 事务时，请求该 Bridge 的主设备需要等待；与此同时，其他主设备仍可能通过 Bus Matrix 访问 Flash 或 SRAM。

### 5.3 减少不必要的寄存器事务

多个读-改-写操作会产生多次总线访问。对同一普通控制寄存器，可以先在 CPU 寄存器中合并修改，再写回一次：

```c
uint32_t value = USARTx->CR1;
value |= MASK_A | MASK_B | MASK_C;
USARTx->CR1 = value;
```

这通常比连续执行三次 `|=` 少两组总线读写，但必须确认目标寄存器允许普通读-改-写。具有 write-one-to-clear、只写位或并发修改语义的寄存器不能机械套用。

STM32F4 的 GPIO 通常挂在 AHB，而不是 APB，因此不应使用 GPIO 寄存器作为“APB 优化”的示例。

### 5.4 APB 定时器时钟

很多 STM32F4 在 APB prescaler 为 1 时令定时器时钟等于 PCLK；prescaler 不为 1 时，常见规则是定时器时钟为 `2 × PCLK`。部分子系列还提供 TIMPRE 等额外配置，因此计算定时器频率时必须查看具体芯片的 RCC clock tree。

## 6. 程序映像与访问路径

典型程序段在启动前后的状态如下：

| 段 | 加载位置 | 运行期位置 | 典型访问路径 |
|----|----------|------------|--------------|
| `.text` | Flash | Flash | 取指走 ICode |
| `.rodata` | Flash | Flash | 数据读取走 DCode |
| `.data` | Flash 中保存初值 | 启动时复制到 SRAM | Flash 读走 DCode，SRAM 写走 System |
| `.bss` | Flash 不保存内容 | 启动时在 SRAM 清零 | System |
| `.ramfunc` | 通常从 Flash 加载 | 配置正确时在 SRAM 执行 | 取指走 System |

```c
/* 启动代码的等效逻辑，符号名称由链接脚本决定 */
memcpy(&_sdata, &_sidata, &_edata - &_sdata);
memset(&_sbss, 0, &_ebss - &_sbss);
```

`.bss` 只在镜像中记录地址和大小，不需要从 Flash 搬运初始化内容。

### 6.1 向量表重定位

向量表默认位于地址空间起始位置对应的启动映射区。应用也可以通过 `VTOR` 把向量表重定位到符合对齐要求的其他区域。

- 向量表在 Code 区：向量读取使用 ICode。
- 向量表在 SRAM/System 区：向量读取使用 System 接口。

修改向量表内容、更新 `VTOR` 或紧接着使能异常时，需要按照 Cortex-M4 编程手册要求使用合适的内存屏障，保证新配置在异常发生前生效。

## 7. DMA、缓存与内存屏障

### 7.1 Cortex-M4 没有通用数据缓存一致性问题

Cortex-M4 内核没有 Cortex-M7 那样的架构级 L1 D-Cache。对常见 STM32F4 来说，DMA 写入普通 SRAM 后，CPU 不需要执行 D-Cache invalidate；DMA 读取普通 SRAM 前，也不需要执行 D-Cache clean。

如果数据异常，更常见的检查方向是：

- 是否等待 DMA 完成后才读取 buffer。
- buffer 是否位于该 DMA 可以访问的内存。
- DMA 数据宽度、地址递增和传输长度是否正确。
- CPU 与 DMA 是否同时拥有同一 buffer 的写权限。
- 用作状态同步的变量是否受到编译器优化影响。

`DMB` 和 `DSB` 用于约束内存访问顺序或等待先前事务完成，不等同于“刷新缓存”。在 DMA 所有权切换、外设配置完成后立即触发操作等场景中，可以根据芯片和 Cortex-M4 编程手册要求使用屏障。

> **M0/M3 差异：** 常见 M0 和 M3 内核同样没有架构级 D-Cache。具体芯片若额外实现缓存或特殊存储接口，仍应按芯片手册处理。

## 8. 常见调试问题

### 8.1 非对齐访问

Cortex-M4 支持部分非对齐的普通内存访问，但不是所有指令和所有内存类型都支持：

- `LDM`、`STM`、`LDRD`、`STRD` 等指令对对齐有额外要求。
- Device/Strongly-ordered 区域不应依赖非对齐访问。
- 设置 `CCR.UNALIGN_TRP` 后，可把部分非对齐访问转为 UsageFault。
- 把任意 `uint8_t *` 强转成更宽指针仍可能产生未定义行为或 Fault。

> **M0/M3 差异：** M0 对非对齐访问的限制更严格；M3 与 M4 的处理方式基本接近。

### 8.2 BusFault 与 Lockup

访问未映射地址、从不可访问区域取指，或总线从设备返回错误，都可能产生 BusFault。定位时应检查：

- `CFSR` 中的 BusFault 状态位。
- `BFARVALID` 是否置位；只有有效时才能把 `BFAR` 当作故障地址。
- `HFSR.FORCED` 是否表示可配置 Fault 已升级为 HardFault。

BusFault handler 内再次产生无法处理的 Fault，通常会先升级为 HardFault；只有在 NMI 或 HardFault handler 中再次发生 HardFault，处理器才会进入 Lockup。Lockup 可以通过复位或调试器处理，不能简单描述成“BusFault handler 出错就只能复位”。

### 8.3 外设时钟未使能

访问外设寄存器前必须先使能对应总线/外设时钟，并在必要时确认时钟写入已经生效。未使能时钟后的读取值、写入效果或错误响应属于芯片实现，不能统一描述为 `PREADY` 永远不拉高。

### 8.4 读-改-写竞争

`register |= mask` 通常由一次读取和一次写回组成。如果中断、另一个执行上下文或硬件在两者之间修改同一寄存器，写回可能覆盖新值。

这个问题来自非原子的 read-modify-write 序列，并不是 APB 两阶段传输特有的问题。应优先使用专用的置位/清零寄存器、原子操作或受保护的临界区。

### 8.5 DMA overrun/underrun

外设产生 DMA request 后，DMA 仍需经过内部仲裁、Bus Matrix、Bridge 和目标存储器。带宽不足或最坏服务延迟过长可能导致 overrun/underrun。

排查时应检查 DMA 映射、stream 优先级、FIFO/burst、外设数据宽度、目标存储器和并发主设备，而不是笼统归因于“REQ 与数据没有对齐”。

## 9. 总结

一次访问的速度首先受目标器件影响：Flash 较慢，读取可能需要等待周期，编程和擦除所需时间更长；片上 SRAM 通常支持零等待访问，但一次读写仍然需要总线周期。缓存命中可以避免真正访问 Flash，从而同时减少器件等待和总线请求，但不能加快 Flash 的编程或擦除。

Bus Matrix 的主要价值，是允许多个主设备并行访问不同的从设备。例如 CPU 从 Flash 取指、DMA 向 SRAM 写数据，两条路径互不冲突时可以同时工作。如果多个请求汇聚到同一个从设备、同一个端口或同一条共享路径，则必须经过仲裁并排队。即使目标是不同的 APB 外设，也可能因为共享同一个 AHB-to-APB Bridge 而发生竞争。

因此，一次访问的耗时可以粗略理解为：

```text
访问延迟 ≈ 器件服务时间 + 总线与 Bridge 传输时间 + 竞争排队时间
```

最终速度取决于完整路径中最慢的一环，而不只是 CPU 或总线的标称频率。DMA 可以把数据搬运工作从 CPU 转移出去，但仍会占用总线和存储器带宽，因此不一定让整个系统更快。

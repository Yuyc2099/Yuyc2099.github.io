# 高性能环形 FIFO 的实现原理

FIFO（First In, First Out）按照“先进先出”的顺序保存数据。环形 FIFO 使用一块固定大小的数组，通过循环移动读写位置重复利用数组空间，不需要在运行期间搬移已有数据。

环形 FIFO 有两种常见实现思路：

- 普通方案把读写位置限制在数组范围内，结构直观，但通常需要保留一个空位。
- 快速方案使用持续递增的读写计数器，并通过位掩码计算物理下标，可以使用全部缓冲区空间。

本文只讨论两种方案的核心原理和差异。

## 1. 普通环形 FIFO

### 1.1 基本结构与读写过程

普通环形 FIFO 通常包含：

- 一块用于保存数据的缓冲区；
- 缓冲区大小 `capacity`；
- 写位置 `write_pos`；
- 读位置 `read_pos`。

写入一个字节时，数据放到 `write_pos` 指向的位置，然后推进写位置：

```c
buffer[write_pos] = value;
write_pos = (write_pos + 1U) % capacity;
```

读取一个字节时，从 `read_pos` 指向的位置取出数据，然后推进读位置：

```c
value = buffer[read_pos];
read_pos = (read_pos + 1U) % capacity;
```

取模运算使读写位置到达数组尾部后重新回到下标 `0`，从而形成环形结构。

### 1.2 索引环绕及满空判断

当读写位置相等时，FIFO 被判断为空：

```text
write_pos == read_pos
```

如果允许写满全部缓冲区，写位置环绕后也会再次等于读位置，满状态就会与空状态完全相同。普通方案通常保留一个空位，用这个空位消除歧义：

```text
空：write_pos == read_pos
满：(write_pos + 1) % capacity == read_pos
```

当前数据长度和可写空间为：

```c
length = (write_pos + capacity - read_pos) % capacity;
available = capacity - length - 1U;
```

因此，一个大小为 `N` 的缓冲区最多只能保存 `N - 1` 个数据。该方案的优点是逻辑直观、容量可以是任意正整数；不足是损失一个存储位置，而且频繁执行取模运算可能增加处理器开销。

## 2. 高性能环形 FIFO

### 2.1 单调递增的读写计数器

快速方案不再把读写变量直接作为数组下标，而是将它们作为累计计数器：

```text
write_count：累计写入位置
read_count： 累计读取位置
```

每成功写入一个数据，`write_count` 加一；每成功读取一个数据，`read_count` 加一。计数器不在到达数组尾部时主动归零。

FIFO 中的数据长度可以直接通过计数器相减得到：

```c
length = write_count - read_count;
```

于是满空状态可以明确区分：

```text
空：write_count - read_count == 0
满：write_count - read_count == capacity
```

### 2.2 逻辑计数器与物理下标分离

累计计数器表示数据流中的逻辑位置，但实际访问数组时仍然需要得到 `0` 到 `capacity - 1` 范围内的物理下标：

```text
逻辑位置：0 1 2 3 4 5 6 7 8 9 ...
物理下标：0 1 2 3 4 5 6 7 0 1 ...   capacity = 8
```

这种分离保留了计数器中的“已经环绕多少次”信息。即使写入位置在数组中重新回到开头，也不会与真正的空状态混淆。

### 2.3 位掩码代替取模运算

当缓冲区大小是 2 的幂时，可以使用位与运算计算物理下标：

```c
index = counter & (capacity - 1U);
```

例如 `capacity` 为 8：

```text
13 % 8 = 5
13 & 7 = 5
```

位与通常比运行期整数取模更简单，特别是在没有硬件除法器的小型处理器上。实际收益仍取决于处理器、编译器和优化等级；如果除数是编译期常量，编译器也可能自动优化取模。

该方法的限制是 `capacity` 必须为 2 的幂，例如：

```text
8、16、32、64、128、256……
```

### 2.4 缓冲区空间的完整利用

快速方案通过计数器差值判断数据量，不需要保留哨兵空位：

```c
length = write_count - read_count;
available = capacity - length;
```

当 `capacity` 为 8 时，FIFO 可以保存完整的 8 个数据：

```text
read_count  = 0
write_count = 8
length      = 8
```

此时写入物理下标虽然已经环绕到 `0`，但两个累计计数器并不相等，所以仍然可以正确判断 FIFO 已满。

### 2.5 无符号计数器的溢出与回绕

累计计数器最终会达到无符号整数的最大值并回绕到 `0`。无符号整数运算按照其位宽自然回绕，因此差值仍然成立。

以 32 位无符号计数器为例：

```text
read_count  = 0xFFFFFFFC
write_count = 0x00000002

write_count - read_count = 6
```

虽然写计数器已经溢出，FIFO 中仍可正确得到 6 个有效数据。

要保证这种行为可靠，需要满足以下条件：

- 计数器必须使用无符号整数；
- 缓冲区大小必须是 2 的幂；
- 写入操作必须保证数据长度不超过缓冲区容量；
- 不能单独清零或随意修改某一个计数器。

## 3. 两种方案的核心差异

| 对比项 | 普通环形 FIFO | 高性能环形 FIFO |
|---|---|---|
| 读写变量 | 数组范围内的物理下标 | 持续递增的逻辑计数器 |
| 下标计算 | `% capacity` | `& (capacity - 1)` |
| 容量要求 | 任意正整数 | 必须是 2 的幂 |
| 实际可用容量 | `capacity - 1` | `capacity` |
| 数据长度 | 环形差值并取模 | 写计数器减读计数器 |
| 满状态判断 | 下一写位置等于读位置 | 计数器差值等于容量 |
| 主要特点 | 简单、容量灵活 | 运算简单、空间利用率高 |

快速方案的性能优势主要来自更简单的长度计算和位掩码寻址。内联可以进一步减少极小函数的调用开销，但并不是性能提升的唯一来源。

## 4. 核心实现示例

下面是经过简化的通用示例，只展示单字节读写和必要的状态计算。示例不包含并发控制、批量复制以及特定平台代码。

### 4.1 内联函数的作用与选择

头文件中的小函数通常使用 `static inline`：

```c
#define FIFO_INLINE static inline
```

其中：

- `static` 使函数只在当前编译单元可见，避免头文件被多个源文件包含时产生重复定义；
- `inline` 建议编译器在调用位置展开函数，但编译器仍可以根据代码尺寸和优化策略拒绝内联。

对于只有一两条有效语句、并且调用非常频繁的函数，可以根据工具链提供一个强制内联宏。例如在支持相应属性的编译器中：

```c
#if defined(__GNUC__) || defined(__clang__)
#define FIFO_FORCE_INLINE static inline __attribute__((always_inline))
#else
#define FIFO_FORCE_INLINE static inline
#endif
```

强制内联适合下标计算、长度计算等极小函数。包含较多分支或数据复制的函数应优先使用普通内联，让编译器决定是否展开，避免多个调用点复制函数体而增加代码尺寸。

### 4.2 状态及下标计算

```c
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint8_t *buffer;
    uint32_t capacity;
    uint32_t write_count;
    uint32_t read_count;
} fast_fifo_t;

FIFO_FORCE_INLINE uint32_t fast_fifo_length(const fast_fifo_t *fifo)
{
    return fifo->write_count - fifo->read_count;
}

FIFO_FORCE_INLINE uint32_t fast_fifo_available(const fast_fifo_t *fifo)
{
    return fifo->capacity - fast_fifo_length(fifo);
}

FIFO_FORCE_INLINE uint32_t fast_fifo_index(const fast_fifo_t *fifo, uint32_t counter)
{
    return counter & (fifo->capacity - 1U);
}
```

初始化时必须检查容量是否为 2 的幂：

```c
FIFO_INLINE bool fast_fifo_init(fast_fifo_t *fifo, uint8_t *buffer, uint32_t capacity)
{
    if ((capacity == 0U) || ((capacity & (capacity - 1U)) != 0U)) {
        return false;
    }

    fifo->buffer = buffer;
    fifo->capacity = capacity;
    fifo->write_count = 0U;
    fifo->read_count = 0U;
    return true;
}
```

### 4.3 简化的写入与读取实现

写入前检查剩余空间，写入数据后再推进写计数器：

```c
FIFO_INLINE bool fast_fifo_put(fast_fifo_t *fifo, uint8_t value)
{
    uint32_t index;

    if (fast_fifo_available(fifo) == 0U) {
        return false;
    }

    index = fast_fifo_index(fifo, fifo->write_count);
    fifo->buffer[index] = value;
    fifo->write_count++;
    return true;
}
```

读取前检查数据长度，取出数据后再推进读计数器：

```c
FIFO_INLINE bool fast_fifo_get(fast_fifo_t *fifo, uint8_t *value)
{
    uint32_t index;

    if (fast_fifo_length(fifo) == 0U) {
        return false;
    }

    index = fast_fifo_index(fifo, fifo->read_count);
    *value = fifo->buffer[index];
    fifo->read_count++;
    return true;
}
```

批量读写仍然遵循相同原理。数据跨越缓冲区尾部时，通常拆成尾部和头部两段进行复制；状态判断和计数器推进方式不变。

该示例适用于说明核心算法。生产者、消费者可能并发执行时，还需要根据处理器和运行环境补充原子操作、临界区或内存屏障，不能仅依赖内联或无符号计数器保证并发安全。

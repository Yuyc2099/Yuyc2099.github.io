# RT-Thread 就绪优先级位图与查找原理

<!--
Author: Yuyc2099
Source-Repository: https://github.com/Yuyc2099/Yuyc2099.github.io
Source-ID: yuyc2099:rt-thread-ready-priority-bitmap:2026-09-02
-->

RT-Thread 的优先级数值越小，实际优先级越高。调度器不逐项遍历优先级，而是从就绪位图中找到最低置位，再访问对应的优先级链表。

> 本文源码基于 RT-Thread v3.1.5。

## 1. 就绪队列与单级位图

每个优先级都有一条就绪链表。它是定义在 `src/scheduler.c` 中的全局数组，不属于任何函数：

```c
rt_list_t rt_thread_priority_table[RT_THREAD_PRIORITY_MAX];
```

位图只说明链表是否为空，线程本身仍保存在链表中。当最大优先级数不超过 32 时，全局变量 `rt_thread_ready_priority_group` 的每一位直接对应一个优先级。线程启动时计算该优先级的掩码：

```c
rt_err_t rt_thread_startup(rt_thread_t thread)
{
    // ...
#if RT_THREAD_PRIORITY_MAX > 32
    // ...
#else
    thread->number_mask = 1L << thread->current_priority;
#endif
    // ...
}
```

`1L << n` 把编号 `n` 转成仅 bit n 为 1 的掩码。例如优先级 5 对应 `0x20`。线程就绪时用 `|=` 置位；该优先级的最后一个线程离开就绪队列后，用 `&= ~mask` 清位。因此一个整数可以同时记录多个非空优先级链表。具体操作见第 4 章。

## 2. 两级位图表示 256 个优先级

32 位整数无法直接表示 256 个优先级，RT-Thread 将其分成 32 组，每组 8 个：

```text
一级位图 bit0  -> 二级位图 table[0]  -> 优先级  0～7
一级位图 bit1  -> 二级位图 table[1]  -> 优先级  8～15
...
一级位图 bit31 -> 二级位图 table[31] -> 优先级 248～255
```

对应的数据结构是：

```c
rt_uint32_t rt_thread_ready_priority_group;
rt_uint8_t rt_thread_ready_table[32];
```

线程启动或优先级改变时，会预先计算组号和两个掩码。以线程启动函数为例：

```c
rt_err_t rt_thread_startup(rt_thread_t thread)
{
    // ...
#if RT_THREAD_PRIORITY_MAX > 32
    thread->number = thread->current_priority >> 3;
    thread->number_mask = 1L << thread->number;
    thread->high_mask = 1L << (thread->current_priority & 0x07);
#endif
    // ...
}
```

8 位优先级可写成 `aaaaa bbb`：

```text
aaaaa：0b00000～0b11111，即 0～31
       -> rt_thread_ready_table[0～31] 的数组下标
       -> rt_thread_ready_priority_group 的 bit0～bit31

bbb：  0b000～0b111，即 0～7
       -> rt_thread_ready_table[number] 的 bit0～bit7
```

因此，高 5 位正好覆盖 `rt_uint8_t rt_thread_ready_table[32]` 的 32 个下标，并对应一级 `rt_uint32_t` 位图的 32 个 bit；低 3 位正好对应一个 `rt_uint8_t` 的 8 个 bit。`number` 保存数组下标，`number_mask` 和 `high_mask` 分别把组号、组内位置转换为 one-hot 掩码。

以优先级 42 为例：

```text
42 = 00101 010
     组号5  组内位置2

number      = 42 >> 3 = 5
number_mask = 1 << 5  = 0x20
high_mask   = 1 << 2  = 0x04
```

若两个位图原本为 0，线程进入就绪队列后：

```text
rt_thread_ready_priority_group
    = 0x00000000 | number_mask
    = 0x00000020                 // bit5 = 1，第5组非空

rt_thread_ready_table[number]
    = rt_thread_ready_table[5]
    = 0x00 | high_mask
    = 0x04                       // bit2 = 1，对应优先级42
```

其他线程已经置位时，按位或只增加这两个标记，不影响原有就绪优先级。

## 3. 最低置位的查找

`__rt_ffs(value)` 从 bit0 向高位查找第一个 1。它的返回值从 1 开始，输入为 0 时返回 0：

```text
value = 0b00101000
              ^ 最低置位是 bit3

__rt_ffs(value) = 4
实际位下标       = 4 - 1 = 3
```

### 3.1 通用查表实现

未启用 `RT_USING_CPU_FFS` 时，`src/kservice.c` 使用 `__lowest_bit_bitmap` 查询一个字节的最低置位。数组下标是 8 位数值，数组元素是最低置位的零基下标。其前 9 项足以看出规律：

| 数值 | 二进制 | 最低置位 | 表中值 |
|---:|:---:|:---:|---:|
| 0 | `00000000` | 无 | 0（占位） |
| 1 | `00000001` | bit0 | 0 |
| 2 | `00000010` | bit1 | 1 |
| 3 | `00000011` | bit0 | 0 |
| 4 | `00000100` | bit2 | 2 |
| 5 | `00000101` | bit0 | 0 |
| 6 | `00000110` | bit1 | 1 |
| 7 | `00000111` | bit0 | 0 |
| 8 | `00001000` | bit3 | 3 |

所有奇数的 bit0 都是 1，所以表中值都是 0；0 没有置位，表中的 0 仅用于占位。

`__rt_ffs` 将 32 位整数从低到高拆成四个字节，先找到最低的非零字节，再查表。

`1、9、17、25` 分别等于四个字节的位偏移 `0、8、16、24` 再加 1。查表结果是零基下标，而 `__rt_ffs` 使用从 1 开始的接口。

{% source file="snippets/__rt_ffs_generic.c" lang="c" title="__rt_ffs() 通用查表实现" origin="src/kservice.c" %}

### 3.2 Cortex-M4 RVDS 实现

Cortex-M4 启用 `RT_USING_CPU_FFS` 后，不会编译上述通用查表实现，而是使用 `libcpu/arm/cortex-m4/cpuport.c` 中的 CPU 专用版本。RVDS 实现先用 `RBIT` 反转 32 位数据，再用 `CLZ` 统计前导零，效果等价于查找原值的最低置位；最后加 1，以保持 `__rt_ffs` 从 1 开始的返回约定。

```text
value == 0 -> 返回 0
value != 0 -> RBIT -> CLZ -> 加 1
```

{% source file="snippets/__rt_ffs_cortex_m4_rvds.c" lang="c" title="__rt_ffs() Cortex-M4 RVDS 实现" origin="libcpu/arm/cortex-m4/cpuport.c" %}

## 4. 就绪位的设置与清除

优先级超过 32 时，线程进入就绪队列需要同时设置两级位图。省略线程状态更新、链表插入、调试输出和中断保护后，位图相关逻辑为：

```c
void rt_schedule_insert_thread(struct rt_thread *thread)
{
    // ...
#if RT_THREAD_PRIORITY_MAX > 32
    rt_thread_ready_table[thread->number] |= thread->high_mask;
#endif
    rt_thread_ready_priority_group |= thread->number_mask;
    // ...
}
```

{% source file="snippets/rt_schedule_insert_thread.c" lang="c" title="rt_schedule_insert_thread()" origin="src/scheduler.c" %}

线程移除后，只有对应优先级链表为空，才能清除二级位；只有整组为空，才能继续清除一级位。省略链表删除和中断保护后，核心逻辑为：

```c
void rt_schedule_remove_thread(struct rt_thread *thread)
{
    // ...
    if (rt_list_isempty(&rt_thread_priority_table[thread->current_priority]))
    {
#if RT_THREAD_PRIORITY_MAX > 32
        rt_thread_ready_table[thread->number] &= ~thread->high_mask;
        if (rt_thread_ready_table[thread->number] == 0)
            rt_thread_ready_priority_group &= ~thread->number_mask;
#else
        rt_thread_ready_priority_group &= ~thread->number_mask;
#endif
    }
    // ...
}
```

这两个判断分别防止误删同一优先级的其他线程，以及同组的其他优先级。

{% source file="snippets/rt_schedule_remove_thread.c" lang="c" title="rt_schedule_remove_thread()" origin="src/scheduler.c" %}

## 5. 最高就绪优先级的恢复

`rt_schedule` 根据最大优先级数选择单级或两级查找。优先级数不超过 32 时查找一次；超过 32 时，第一次查找非空组，第二次查找组内优先级：

```c
void rt_schedule(void)
{
    // ...
#if RT_THREAD_PRIORITY_MAX <= 32
    highest_ready_priority =
        __rt_ffs(rt_thread_ready_priority_group) - 1;
#else
    number = __rt_ffs(rt_thread_ready_priority_group) - 1;
    highest_ready_priority = (number << 3) +
        __rt_ffs(rt_thread_ready_table[number]) - 1;
#endif

    // ...
    to_thread = rt_list_entry(
        rt_thread_priority_table[highest_ready_priority].next,
        struct rt_thread, tlist);
    // ...
}
```

恢复公式为：

```text
优先级 = 组号 × 8 + 组内位置
```

`#if RT_THREAD_PRIORITY_MAX > 32` 只改变最高优先级的查找方式，不会缩小第 1 章定义的 `rt_thread_priority_table`。当 `RT_THREAD_PRIORITY_MAX` 为 256 时，该数组仍会静态分配 256 个链表头，下标 `0～255` 分别对应 256 个优先级。两级位图找到 `highest_ready_priority` 后，`rt_schedule` 直接以它访问链表。

因此，两级位图省去的是逐个检查 256 条链表的时间，并没有省掉 `rt_thread_priority_table` 的空间。这是用固定的链表头数组换取查找完成后的直接索引。

若仅优先级 42 就绪，一级位图先得到组号 5，二级位图再得到组内位置 2，最终恢复出 `5 × 8 + 2 = 42`。如果多个优先级同时就绪，最低置位对应数值最小的优先级，也就是 RT-Thread 定义的最高优先级。

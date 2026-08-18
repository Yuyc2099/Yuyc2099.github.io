# 裸机架构笔记：轮询状态机、OSAL、LTX、Protothreads、QP/C 与 setjmp/longjmp

<!--
Author: Yuyc2099
Source-Repository: https://github.com/Yuyc2099/Yuyc2099.github.io
Source-ID: yuyc2099:bare-metal-event-driven-architectures:2026-07-22
-->

裸机程序没有线程调度器，但同样要同时处理按键、传感器、通信、显示和超时。不同架构的区别，主要不在于提供了哪些 API，而在于怎样保存执行状态、怎样把事件交给业务代码，以及一段流程等待后怎样继续运行。

---

## 1. 裸机并发的基本问题

### 1.1 状态保存与非阻塞执行

最直接的裸机程序是把所有工作依次写进主循环：

```c
for (;;) {
    scan_key();
    update_sensor();
    run_protocol();
    refresh_display();
}
```

这种结构本身没有问题，问题出现在某个函数需要等待。例如传感器上电后要等待 10 ms 才能启动校准，如果直接调用阻塞延时，等待期间协议和显示也无法运行：

```c
sensor_power_on();
delay_ms(10);
sensor_start_calibration();
```

非阻塞实现必须在等待前保存两类信息：当前执行到了哪里，以及恢复时仍然需要哪些数据。随后函数返回主循环，让其他工作继续执行；等定时器或外设事件到达后，再从保存的位置继续推进。

不同架构使用不同方式保存这两类状态：轮询状态机使用枚举和上下文结构体，OSAL 使用任务状态和事件位，LTX 使用业务对象、话题和可选的 Script 步骤，Protothreads 保存局部续执行位置，QP/C 把状态放进活动对象的层次状态机，而栈式协程还要保存寄存器环境和独立调用栈。

因此，裸机并发并不一定意味着同时执行多条指令。更常见的含义是：多个流程各自保存进度，每次只运行一小段，然后主动交还 CPU。

### 1.2 事件产生、调度与恢复

一个完整的非阻塞系统通常包含三个环节：

```text
中断、定时器、其他模块
          │
          │ 产生事件或更新条件
          ▼
事件位、就绪队列、消息队列
          │
          │ 调度
          ▼
状态机、回调或协程恢复执行
```

中断适合确认硬件状态、搬走必要数据并通知前台，不适合在其中完成整个业务流程。前台调度器根据事件位、队列或轮询条件找到可以继续运行的工作，再调用相应处理函数。

多数轻量裸机架构都要求一次处理尽快结束：处理函数读取事件、推进状态、登记下一次等待，然后返回。这种方式称为运行到完成。它不要求业务一步完成，只要求每一步不能停在阻塞等待中。

事件也不一定都表示同一种语义。一个布尔标志或事件位只能表示“至少发生过一次”，重复通知会合并；计数器可以保留发生次数；消息队列或环形缓冲区才能保存每一份数据。架构决定事件如何调度，应用仍要根据业务语义选择正确的数据保存方式。

---

## 2. 轮询状态机

### 2.1 显式状态与上下文

轮询状态机把原本连续的阻塞流程拆成多个状态。状态枚举保存执行位置，上下文结构体保存跨状态使用的数据：

```c
typedef enum {
    SENSOR_OFF,
    SENSOR_POWER_WAIT,
    SENSOR_CALIBRATING,
    SENSOR_RUNNING,
    SENSOR_FAILED
} sensor_state_t;

typedef struct {
    sensor_state_t state;
    uint32_t deadline;
    uint16_t latest_sample;
} sensor_t;
```

每次调用状态机只处理当前状态能够完成的工作。需要等待时，它记录下一状态或截止时间并立即返回：

```c
void sensor_start(sensor_t *sensor, uint32_t now)
{
    sensor_power_on();
    sensor->deadline = now + 10U;
    sensor->state = SENSOR_POWER_WAIT;
}

void sensor_step(sensor_t *sensor, uint32_t now)
{
    switch (sensor->state) {
    case SENSOR_POWER_WAIT:
        if ((int32_t)(now - sensor->deadline) >= 0) {
            sensor_start_calibration();
            sensor->state = SENSOR_CALIBRATING;
        }
        break;

    case SENSOR_CALIBRATING:
        if (sensor_calibration_done()) {
            sensor->state = SENSOR_RUNNING;
        }
        break;

    case SENSOR_RUNNING:
        sensor_try_read(&sensor->latest_sample);
        break;

    default:
        break;
    }
}
```

这里没有隐藏的调度状态。程序恢复到哪里、哪些数据需要保留，都能从结构体直接看见。代价是流程变长后，原本连续的业务逻辑会被拆散在多个 `case` 中，状态迁移和异常路径需要应用自己维护。

### 2.2 Super Loop 中的状态推进

多个状态机由主循环依次推进：

```c
for (;;) {
    uint32_t now = system_tick();

    sensor_step(&sensor, now);
    protocol_step(&protocol, now);
    display_step(&display, now);
}
```

这种调度没有就绪队列。即使某个模块没有工作，主循环仍会调用它检查当前状态，因此一次完整扫描的成本随状态机数量增加。事件响应时间也取决于排在前面的函数执行了多久。

轮询状态机要保持可用，每个 `step()` 都必须有明确执行上限。读取串口时不能一直处理到缓冲区为空，可以限定本轮最多处理几帧；等待外设时不能原地循环，只能检查一次条件后返回。

低功耗实现还需要从所有状态机中找出最近截止时间，并在没有即时工作时进入休眠。也就是说，状态机只解决了流程如何分段，定时器管理、事件排队和空闲休眠仍要由主循环或额外组件提供。

---

## 3. OSAL

### 3.1 任务、事件位与消息

OSAL 以任务为中心组织业务。每个任务拥有任务 ID、静态优先级、事件处理函数和一组事件位，核心结构可以简化为：

```c
typedef struct OSALTaskREC {
    struct OSALTaskREC *next;
    void (*init)(uint8_t task_id);
    uint16_t (*process)(uint8_t task_id, uint16_t events);
    uint8_t task_id;
    uint8_t priority;
    uint16_t events;
} osal_task_t;
```

中断、软件定时器和其他任务通过 `osal_set_event()` 把事件位合并到目标任务：

```c
task->events |= event_flag;
```

事件位只记录某类工作是否待处理。同一位在任务运行前被设置多次，最终仍然只有一个 bit，所以它适合表达“配置发生变化”或“缓冲区中已有数据”，不适合直接记录每一次数据到达。

任务处理函数收到本轮事件集合，处理其中一部分后返回尚未处理的事件：

```c
uint16_t sensor_process(uint8_t task_id, uint16_t events)
{
    if ((events & EVT_SAMPLE_READY) != 0U) {
        consume_samples();
        return events & (uint16_t)~EVT_SAMPLE_READY;
    }

    return events;
}
```

如果每次都无条件返回 `0`，同批到达但尚未处理的其他事件就会丢失。这个返回协议是 OSAL 事件模型的一部分，而不是普通回调的可选写法。

需要保存每一份负载时，OSAL 使用消息队列。发送方从 OSAL 内存池分配消息，将消息加入全局链表，再设置目标任务的 `SYS_EVENT_MSG`。事件位负责唤醒，消息节点负责保存数据；接收方处理后必须归还内存。这样补足了事件位的合并语义，但也引入了容量、分配失败、所有权和释放时机等问题。

### 3.2 优先级扫描与软件定时器

OSAL 按优先级排列任务链表。调度器每轮从链表头开始寻找第一个事件非零的任务，取走其事件集合，再调用任务处理函数：

```c
for (;;) {
    task = osal_next_active_task();
    if (task == NULL) {
        continue;
    }

    events = take_task_events(task);
    remaining = task->process(task->task_id, events);
    restore_task_events(task, remaining);
}
```

优先级决定下一次选择哪个就绪任务，但不会抢占正在运行的处理函数。高优先级事件到达后，仍要等当前函数返回。因此处理函数必须把长流程拆成多个事件步骤。

查找就绪任务最坏需要检查全部 `T` 个任务。当前实现没有就绪位图或独立就绪队列，空闲时也会反复扫描任务链表；要进入低功耗状态，需要在移植层增加安全的判空和 Idle 路径。

OSAL 软件定时器保存目标任务、事件位、剩余时间和可选的重装周期。每次硬件 Tick 都遍历全部活跃定时器，递减剩余时间；到期后给目标任务设置事件。因此每 Tick 的成本为 `O(A)`，其中 `A` 是活跃定时器数量。

OSAL 的整体设计可以概括为：任务是状态和事件的归属边界，事件位负责低成本唤醒，消息负责逐条数据传递，软件定时器负责在未来产生任务事件。它提供的是一套协作式任务运行环境，而不是带独立任务栈的 RTOS。

---

## 4. LTX

### 4.1 话题、订阅者与就绪队列

LTX 不先建立任务，而是把系统中的状态变化定义为话题。话题保存订阅者链表，同时也是就绪队列中的节点：

```c
struct ltx_topic {
    uint8_t pending;
    struct ltx_subscriber subscriber_head;
    struct ltx_subscriber *subscriber_tail;
    struct ltx_topic *next;
};
```

发布话题时，LTX 设置 `pending`；如果话题尚未排队，再把它加入就绪队列尾部。调度器从队首取出话题，然后按订阅顺序调用全部回调：

```text
生产者更新共享状态
        │
        ▼
    发布话题
        │
        ▼
话题进入就绪队列
        │
        ▼
依次调用所有订阅者
```

同一话题在尚未处理时被连续发布，只保留一次待处理状态。这种设计避免了重复话题无限占用队列，也表明话题表达的是“相关状态已经变化”，而不是每一次变化的数据快照。若每一帧数据都必须保留，生产者应先写入环形缓冲区，再发布“缓冲区非空”话题。

话题发布和队首弹出都可以做到 `O(1)`，完整分发仍要遍历 `S` 个订阅者。回调依然运行到完成，一个慢订阅者会推迟同一话题的后续订阅者，也会推迟就绪队列中的其他话题。

订阅者通常作为侵入式节点嵌入业务对象，回调通过节点地址找回所属对象。对象和节点由应用静态提供，因此 LTX 核心不需要为每次发布动态分配内存。相应地，话题只负责通知，业务数据的生命周期和并发访问仍由应用定义。

### 4.2 差分闹钟与 Tickless 调度

LTX 用按到期顺序排列的差分链表管理闹钟。每个节点不保存绝对到期时间，而是保存相对前一个节点还需要等待多少 Tick。例如三个闹钟分别在第 5、12、20 Tick 到期，链表保存：

```text
head -> A(+5) -> B(+7) -> C(+8)
绝对时间  5        12        20
```

插入第 9 Tick 到期的闹钟时，需要拆分 B 的差值：

```text
head -> A(+5) -> D(+4) -> B(+3) -> C(+8)
绝对时间  5         9        12        20
```

插入需要寻找位置，最坏为 `O(A)`；但每次 Tick 只需递减表头，到期时弹出表头以及后续所有差值为零的节点，成本为 `O(1 + K)`。它把固定 Tick 中的全表扫描转移到了相对低频的闹钟插入操作。

表头还直接给出了距离最近闹钟的时间，因此硬件定时器可以一次设置到最近到期点，而不必保持固定周期唤醒。这就是 LTX Tickless 的基础。

LTX 可以用最低优先级 PendSV 执行话题调度，把主循环留作 Idle：

```c
int main(void)
{
    system_init();

    for (;;) {
        __WFI();
    }
}

void PendSV_Handler(void)
{
    ltx_Sys_scheduler();
}
```

PendSV 在这里提供的是统一调度上下文，不是线程上下文切换。所有订阅回调仍共享同一个栈并运行到完成。闹钟与话题还可以组合成 Script：步骤号保存流程位置，闹钟实现非阻塞延时，话题实现条件唤醒。Script 是 LTX 核心机制的组合，而不是另一套调度器。

---

## 5. Protothreads

### 5.1 基于 `switch/case` 的局部续执行

Protothreads 试图让无栈状态机写得更接近顺序代码。它的基础是局部续执行：等待前记录源代码位置，下一次调用函数时直接跳回该位置。

典型实现利用 `switch/case` 和 `__LINE__`：

```c
#define LC_BEGIN(ctx) switch ((ctx)->line) { case 0:
#define LC_SET(ctx) \
    do { \
        (ctx)->line = __LINE__; \
        case __LINE__:; \
    } while (0)
#define LC_END(ctx) }
```

Protothread 上下文只需要保存这个位置编号。`PT_BEGIN()` 展开为 `switch`，`PT_WAIT_UNTIL()` 保存当前行号并在条件不满足时返回，`PT_END()` 关闭整个控制结构。

因此下面看起来连续的代码，实际会在两个等待点之间多次返回和重新进入：

```c
PT_THREAD(sensor_thread(struct pt *pt, sensor_t *sensor))
{
    PT_BEGIN(pt);

    sensor_power_on();
    timer_start(&sensor->timer, 10U);
    PT_WAIT_UNTIL(pt, timer_expired(&sensor->timer));

    sensor_start_calibration();
    PT_WAIT_UNTIL(pt, sensor->calibration_done);

    sensor_enable_sampling();
    PT_END(pt);
}
```

Protothreads 没有保存程序栈，也没有在任意指令位置切换。它只是把手写的“状态编号 + 下次从哪个 `case` 继续”封装到宏中。

### 5.2 无栈等待与外部轮询调度

Protothreads 本身不决定哪个流程何时运行。最简单的使用方式仍然是在主循环中反复调用每个 Protothread：

```c
for (;;) {
    PT_SCHEDULE(sensor_thread(&sensor_pt, &sensor));
    PT_SCHEDULE(protocol_thread(&protocol_pt, &protocol));
}
```

也可以由事件框架只在条件变化时重新调用相应 Protothread。无论采用哪种方式，定时器、事件队列、优先级和空闲休眠都来自外部调度环境，而不是局部续执行本身。

由于等待时函数已经返回，普通自动变量不能可靠地跨等待点保存。需要保留的数据必须放入业务上下文、静态存储或其他生命周期足够长的对象中。调用的子函数也不能在自己的深层调用栈中随意挂起，因为 Protothreads 没有保存那段调用栈。

基于行号和 `switch` 的实现还会对代码结构形成约束，例如两个续执行宏不能放在同一源代码行，宏内部的 `case` 会影响嵌套 `switch` 的写法。它换来的好处是每个流程只需极少的状态存储，同时让等待步骤比手写状态机更接近顺序阅读。

---

## 6. QP/C

### 6.1 活动对象与异步事件队列

QP/C 以活动对象作为并发单元。每个活动对象封装自己的状态机、私有数据、事件队列和优先级；其他模块不能直接驱动它的状态变化，只能异步投递事件。

```text
中断或其他活动对象
          │
          │ POST / PUBLISH
          ▼
   活动对象的事件队列
          │
          ▼
      内部状态机
```

直接投递会把每个事件加入目标对象的 FIFO 队列，因此它与事件位或 LTX 话题的合并语义不同。只要队列容量足够，多次到达的事件可以逐条处理，事件对象也可以携带参数。发布订阅则把同一事件分发给所有订阅该信号的活动对象，随后仍由各自队列独立消费。

事件队列既实现异步解耦，也划定了容量边界。应用必须在设计阶段确定队列深度以及队满时的处理策略。动态事件还涉及内存池和引用计数，静态事件则适合没有独立负载或生命周期固定的通知。

调度器根据活动对象优先级选择就绪对象。活动对象每次从自己的队列取出一个事件并分派给状态机，处理完后再接收下一个事件。对象之间不共享一条业务调用栈，也不通过同步调用等待对方返回，而是用事件建立因果关系。

### 6.2 层次状态机与运行到完成

QP/C 的活动对象内部不是普通回调集合，而是层次状态机。父状态可以处理多个子状态共有的事件，进入和退出动作则规定状态转换时需要执行的初始化与清理：

```text
Sensor
├── Off
└── On
    ├── Calibrating
    └── Sampling
```

例如 `POWER_OFF` 可以由父状态 `On` 统一处理，不必在 `Calibrating` 和 `Sampling` 中重复代码。从 `Calibrating` 转移到 `Sampling` 时，框架按照层次关系执行退出动作、转换动作和进入动作，使状态迁移过程具有明确语义。

每个事件的状态机分派都运行到完成：当前事件触发的状态转换必须结束，活动对象才会处理下一个事件。等待硬件、超时或其他对象响应时，状态机应完成当前分派并返回，之后由新事件再次进入，而不是停在处理函数中阻塞。

时间事件按照指定 Tick 到期后向活动对象投递普通事件，因此延时与其他输入使用同一套状态迁移机制。活动对象不需要在每次执行时主动查询所有等待条件。

运行到完成描述的是事件处理语义，不等于 QP/C 只能使用协作式调度。协作式内核会等当前分派返回后再运行其他活动对象；抢占式内核可以让更高优先级活动对象获得 CPU，但每个活动对象内部仍以完整处理一个事件为基本步骤，不会把阻塞等待隐藏在状态机中。

---

## 7. setjmp/longjmp

### 7.1 执行环境的保存与恢复

标准 C 的 `setjmp()` 把当前调用环境保存到 `jmp_buf`，首次调用返回 `0`；以后调用 `longjmp()` 恢复这个环境时，同一个 `setjmp()` 会再次返回，并得到非零值：

```c
static jmp_buf recovery_point;

void run_operation(void)
{
    int reason = setjmp(recovery_point);

    if (reason == 0) {
        call_operation_chain();
        return;
    }

    handle_failure(reason);
}

void abort_operation(int reason)
{
    longjmp(recovery_point, reason);
}
```

这里的 `longjmp()` 可以跨越多层函数调用，直接回到保存点，所以常用于非局部错误退出。它恢复的是实现定义的执行环境，不应该简单理解为复制并恢复了一整块调用栈。

跳转目标所在的函数调用必须仍然有效。如果保存环境的函数已经返回，再用 `longjmp()` 跳回该环境，程序行为没有有效保证。`setjmp()` 之后、`longjmp()` 之前被修改的非 `volatile` 自动变量，也不能假定仍保留跳转前的值。

因此，标准 `setjmp/longjmp` 提供的是非局部跳转原语，本身不是任务、调度器或完整协程。

### 7.2 独立栈协程与外部调度器

要用 `setjmp/longjmp` 构造可以在深层函数中挂起的栈式协程，每个协程还需要自己的栈。协程第一次启动时，运行时必须让 CPU 在这块独立栈上进入协程入口；之后才能用 `setjmp()` 保存协程环境，用 `longjmp()` 在调度器和协程之间恢复执行：

```text
调度器环境
    │ longjmp
    ▼
协程 A 环境 + 协程 A 栈
    │ yield: setjmp(A) + longjmp(scheduler)
    ▼
调度器环境
```

每个协程通常至少需要：

- 一块独立栈及其边界；
- 一个保存执行环境的 `jmp_buf`；
- 就绪、等待和结束状态；
- 由调度器管理的队列或链表。

定时等待也不是 `longjmp()` 自动提供的。协程挂起前要把自己加入定时器或事件等待队列，调度器在条件满足后再把它移回就绪队列。这样形成的才是一套协程运行时。

标准 C 没有提供“在指定栈上首次调用函数”的可移植接口。实际实现通常需要汇编入口、编译器扩展或针对 ABI 修改初始寄存器环境，还要决定是否保存浮点寄存器、中断屏蔽状态等平台上下文。因此这类方案的主要成本不是 `setjmp/longjmp` 两个调用，而是独立栈管理和平台端口。

栈式协程能够让普通局部变量和深层函数调用自然跨越挂起点，但每个协程都要预留栈空间，也更容易隐藏长时间不让出的代码。调度器仍需规定协程只能在明确位置主动让出，并对栈溢出、资源清理和错误跳转进行约束。

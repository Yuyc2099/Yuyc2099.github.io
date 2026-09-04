void rt_schedule(void)
{
    rt_base_t level;
    struct rt_thread *to_thread;
    struct rt_thread *from_thread;

    /* disable interrupt */
    level = rt_hw_interrupt_disable();

    /* check the scheduler is enabled or not */
    if (rt_scheduler_lock_nest == 0)
    {
        register rt_ubase_t highest_ready_priority;

#if RT_THREAD_PRIORITY_MAX <= 32
        highest_ready_priority = __rt_ffs(rt_thread_ready_priority_group) - 1;
#else
        register rt_ubase_t number;

        number = __rt_ffs(rt_thread_ready_priority_group) - 1;
        highest_ready_priority = (number << 3) + __rt_ffs(rt_thread_ready_table[number]) - 1;
#endif

        /* get switch to thread */
        to_thread = rt_list_entry(rt_thread_priority_table[highest_ready_priority].next,
                                  struct rt_thread,
                                  tlist);

        /* if the destination thread is not the same as current thread */
        if (to_thread != rt_current_thread)
        {
            rt_current_priority = (rt_uint8_t)highest_ready_priority;
            from_thread         = rt_current_thread;
            rt_current_thread   = to_thread;

            RT_OBJECT_HOOK_CALL(rt_scheduler_hook, (from_thread, to_thread));

            /* switch to new thread */
            RT_DEBUG_LOG(RT_DEBUG_SCHEDULER,
                         ("[%d]switch to priority#%d "
                          "thread:%.*s(sp:0x%p), "
                          "from thread:%.*s(sp: 0x%p)\n",
                          rt_interrupt_nest, highest_ready_priority,
                          RT_NAME_MAX, to_thread->name, to_thread->sp,
                          RT_NAME_MAX, from_thread->name, from_thread->sp));

#ifdef RT_USING_OVERFLOW_CHECK
            _rt_scheduler_stack_check(to_thread);
#endif

            if (rt_interrupt_nest == 0)
            {
                rt_hw_context_switch((rt_ubase_t)&from_thread->sp,
                                     (rt_ubase_t)&to_thread->sp);

#ifdef RT_USING_SIGNALS
                if (rt_current_thread->stat & RT_THREAD_STAT_SIGNAL_PENDING)
                {
                    extern void rt_thread_handle_sig(rt_bool_t clean_state);

                    rt_current_thread->stat &= ~RT_THREAD_STAT_SIGNAL_PENDING;

                    rt_hw_interrupt_enable(level);

                    /* check signal status */
                    rt_thread_handle_sig(RT_TRUE);
                }
                else
#endif
                {
                    /* enable interrupt */
                    rt_hw_interrupt_enable(level);
                }

                return ;
            }
            else
            {
                RT_DEBUG_LOG(RT_DEBUG_SCHEDULER, ("switch in interrupt\n"));

                rt_hw_context_switch_interrupt((rt_ubase_t)&from_thread->sp,
                                               (rt_ubase_t)&to_thread->sp);
            }
        }
    }

    /* enable interrupt */
    rt_hw_interrupt_enable(level);
}

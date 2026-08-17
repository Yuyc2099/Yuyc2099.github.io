# 电机最高转速估算与反电动势测量

## 1. 软件转速限制

```c
#define ui_i32MinSpeedRpm     (100)
#define ui_i32MaxSpeedRpm     (3000)
```

`ui_i32MaxSpeedRpm` 是目标转速的软件上限。调大它只能允许设置更高的目标转速，不能保证电机实际达到该转速。

## 2. 基准参数

```text
ui_f32BaseVoltage   = 12 V
ui_f32BaseFrequency = 150 Hz
ui_i32PolePairs     = 3
```

电气频率与机械转速的关系：

```text
电气频率 = 机械转速 × 极对数 / 60
机械转速 = 60 × 电气频率 / 极对数
```

当前基准机械转速为：

```text
60 × 150 / 3 = 3000 rpm
```

`ui_f32BaseFrequency` 是软件标幺计算的基准值。单独调大它不会提高电机的实际最高转速。

## 3. 12 V 母线下的转速估算

```c
#define MOTOR_Ke_VPP        (11.2f)
#define MOTOR_Ke_Freq       (71.43f)
```

- `MOTOR_Ke_VPP`：线间反电动势峰峰值，单位 V。
- `MOTOR_Ke_Freq`：测量该反电动势时的电气频率，单位 Hz。

相电压峰值：

```text
Ephase_peak = 11.2 / (2 × √3) ≈ 3.23 V
```

当前软件允许的最大相电压矢量约为：

`MaxVsK` 是最大输出定子电压矢量系数，表示允许输出的最大电压矢量幅值与直流母线电压之比：

```text
MaxVsK = Vphase_max / Vbus
Vphase_max = Vbus × MaxVsK = 12 × 0.55 = 6.6 V
```

理论上，最大相电压矢量为 `Vbus / √3`：

```text
MaxVsK_theory = 1 / √3 ≈ 0.577
```

考虑调制限制、死区和电压裕量，工程上取 `MaxVsK = 0.55`。

理想空载电气频率和机械转速约为：

```text
fmax = 71.43 × 6.6 / 3.23 ≈ 146 Hz
nmax = 60 × 146 / 3 ≈ 2920 rpm
```

所以，当前 `3000 rpm` 的软件上限与 12 V 母线下的估算结果基本一致。以上结果是理想空载估算，实际带载转速会更低。

## 4. 反电动势参数测量

`MOTOR_Ke_VPP` 和 `MOTOR_Ke_Freq` 必须由同一次测量得到。电机固有参数是二者的比例，以及据此计算出的反电动势系数或永磁体磁链。

测量的重点是保持电机匀速，具体转速不固定。磁链不变时，转速只会使反电动势和频率同比变化，二者的比值基本不变。

测量步骤：

1. 将电机 U、V、W 三相与逆变器完全断开。
2. 使用其他机械装置拖动电机匀速旋转。
3. 用示波器测量任意两相之间的开路线电压，例如 U-V。
4. 读取波形峰峰值和周期：

```text
MOTOR_Ke_VPP  = Vmax - Vmin
MOTOR_Ke_Freq = 1 / T
```

当前磁链计算公式：

```c
#define MOTOR_Ke_VPP        (11.2f)
#define MOTOR_Ke_Freq       (71.43f)
#define MOTOR_Ke2lamda      ((MOTOR_Ke_VPP / 2 / _SQRT_3) / (_2PI() * MOTOR_Ke_Freq))
```

即：

```text
LambdaF = MOTOR_Ke_VPP / (4π × √3 × MOTOR_Ke_Freq)
        = 11.2 / (4π × 1.732 × 71.43)
        ≈ 0.00720 Wb
```
## 5. 最大转速快速计算


```text
最大机械转速rpm = 120 × √3 × MaxVsK × f(反电动势) × V(母线) / ( V(反电动势) × 极对数)

最大机械转速rpm = 120 × f(反电动势) × V(母线) / ( V(反电动势) × 极对数)
最大机械转速rpm = 120 × 1000 × V(母线) / ( V(反电动势) × 极对数 × t(反电动势ms) )
```

工程应用中，`MaxVsK` 通常会取小于 `1 / √3` 的值，以留出调制、死区和电压裕量。因此，使用实际 `MaxVsK` 代入通用公式得到的最大转速会低于上述理论简式的计算结果。

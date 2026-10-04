package com.lightningstudio.watchrss.data.media
fun main() {
    val rows=mutableListOf<String>()
    val sequences=listOf(
        listOf(0L to -.1f, 1L to -.125f, 2L to .333f, 3L to -1.37f),
        listOf(0L to -400f, 10L to -400f, 610L to -400f, 1211L to -400f),
        listOf(0L to -100f, 1L to 50f, 2L to -600f, 3L to -600f),
        listOf(0L to 100f, 10L to -50f, 20L to 0f, 30L to -400f),
        listOf(0L to -10000f, 1000L to -10000f, 1500L to 10000f, 2000L to -10000f)
    )
    for ((min,max) in listOf(0 to 0,0 to 1,0 to 3,0 to 15,0 to 25,2 to 15)) for(initial in min..max) for(enabled in listOf(false,true)) for(seq in sequences) {
        var current=initial.toFloat();var state=DigitalCrownVolumeGuardState()
        val cap=volumeForPercent(.21f,min,max)
        for((time,raw) in seq) {
            val delta=(-raw*.01f)*((max-min)*.06f)
            val result=applyDigitalCrownVolumeGuard(current,delta,min,max,enabled,cap,state,time)
            val last=if(state.lastEventUptimeMs==Long.MIN_VALUE) "null" else state.lastEventUptimeMs.toString()
            rows.add("{\"raw\":$raw,\"current\":$current,\"delta\":$delta,\"min\":$min,\"max\":$max,\"enabled\":$enabled,\"eventMs\":$time,\"previous\":{\"cap\":${state.sessionCapVolume},\"lastEventMs\":$last,\"notified\":${state.guardNotificationShown}},\"target\":${result.targetVolume},\"notify\":${result.shouldNotifyGuardTriggered},\"next\":{\"cap\":${result.nextState.sessionCapVolume},\"lastEventMs\":${if(result.nextState.lastEventUptimeMs==Long.MIN_VALUE) "null" else result.nextState.lastEventUptimeMs},\"notified\":${result.nextState.guardNotificationShown}}}")
            current=result.targetVolume;state=result.nextState
        }
    }
    print(rows.joinToString(",","[","]"))
}

package com.lightningstudio.watchrss.data.media
import com.lightningstudio.watchrss.data.settings.normalizeMediaPlaybackStartVolumeLimitPercent
import kotlin.math.roundToInt
fun main() {
    val cases = mutableListOf<String>()
    for ((min, max) in listOf(0 to 0, 0 to 1, 0 to 3, 0 to 15, 0 to 25, 0 to 100, 2 to 15, 5 to 5)) {
        for (current in min..max) for (raw in listOf<Int?>(null, -1, 3, 105) + (0..100 step 5).toList()) {
            val limit = normalizeMediaPlaybackStartVolumeLimitPercent(raw)
            val target = if (shouldEnforcePlaybackStartGuard(limit, false, current, min, max)) {
                playbackStartVolumeForPercent(limit!!, min, max).roundToInt().coerceIn(min, max).takeIf { it != current }
            } else null
            cases.add("{\"min\":$min,\"max\":$max,\"current\":$current,\"limit\":$raw,\"target\":$target}")
        }
    }
    print(cases.joinToString(",", "[", "]"))
}

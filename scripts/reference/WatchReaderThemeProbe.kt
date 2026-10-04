package com.lightningstudio.watchrss.data.reader

import java.time.LocalDate
import java.time.ZoneId

fun main() {
    val places = listOf(
        Triple(39.9042, 116.4074, "Asia/Shanghai"),
        Triple(40.7128, -74.0060, "America/New_York"),
        Triple(51.5074, -0.1278, "Europe/London"),
        Triple(-33.8688, 151.2093, "Australia/Sydney"),
        Triple(27.7172, 85.3240, "Asia/Kathmandu"),
        Triple(22.5726, 88.3639, "Asia/Kolkata"),
        Triple(-43.95, -176.55, "Pacific/Chatham"),
        Triple(1.8721, -157.4278, "Pacific/Kiritimati"),
        Triple(69.6492, 18.9553, "Europe/Oslo"),
        Triple(-77.8419, 166.6863, "Antarctica/McMurdo"),
        Triple(90.0, 0.0, "UTC"),
        Triple(-90.0, 0.0, "UTC")
    )
    val dates = (1..366 step 17).map { LocalDate.ofYearDay(2024, it) } +
        listOf("2024-02-29", "2026-03-08", "2026-03-29", "2026-04-05", "2026-10-04", "2026-10-25", "2026-11-01").map(LocalDate::parse)
    val records = mutableListOf<String>()
    for (date in dates) for ((lat, lon, zone) in places) {
        val result = WatchSunCalculator.calculate(date, lat, lon, ZoneId.of(zone))
        val times = result?.let { "{\"sunrise\":${it.sunrise.hour * 60 + it.sunrise.minute},\"sunset\":${it.sunset.hour * 60 + it.sunset.minute}}" } ?: "null"
        records += "{\"date\":\"$date\",\"latitude\":$lat,\"longitude\":$lon,\"zone\":\"$zone\",\"times\":$times}"
    }
    println("[" + records.joinToString(",\n") + "]")
}

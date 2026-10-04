package com.lightningstudio.watchrss.data.reader

import org.json.JSONArray
import org.json.JSONObject

fun main(args: Array<String>) {
    val inputs = JSONArray(java.io.File(args[0]).readText())
    val output = JSONArray()
    for (index in 0 until inputs.length()) {
        val input = inputs.getJSONObject(index)
        val preset = ReaderPresetCodec.decode(input.toString())
        val styles = JSONObject()
        for (role in ReaderTypographyRole.entries) {
            styles.put(role.name.lowercase(), JSONObject(ReaderPresetCodec.encode(preset.copy(body = preset.resolvedStyle(role)))).getJSONObject("body"))
        }
        output.put(JSONObject().put("input", input).put("normalized", JSONObject(ReaderPresetCodec.encode(preset))).put("styles", styles))
    }
    println(output)
}

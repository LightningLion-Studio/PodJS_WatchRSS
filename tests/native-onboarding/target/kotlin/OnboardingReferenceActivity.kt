package dev.podjs.reference

import android.os.Bundle
import com.lightningstudio.watchrss.BaseWatchActivity

class OnboardingReferenceActivity : BaseWatchActivity() {
    override fun isSwipeBackEnabled() = false
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setupSystemBars()
    }
}

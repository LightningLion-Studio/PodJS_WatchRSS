package dev.podjs.androidwatch.reference

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.lightningstudio.watchrss.data.network.InternetAvailabilityStatus
import com.lightningstudio.watchrss.ui.screen.bili.BiliPlayerScreen
import com.lightningstudio.watchrss.ui.viewmodel.BiliPlayerUiState
import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme

class ReferencePlayerActivity : ComponentActivity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContent {
          WatchRSSTheme {
            BiliPlayerScreen(
                uiState = BiliPlayerUiState(isLoading = false, message = null),
                onRetry = {}, onOpenWeb = {},
                internetAvailabilityStatus = InternetAvailabilityStatus.Available,
                onPanStateChange = { _, _ -> }, isActive = true,
                digitalCrownVolumeEnabled = false, volumeGuardEnabled = false,
                playbackStartVolumeLimitPercent = null
            )
          }
        }
    }
}

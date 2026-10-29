package app.mysafe

import android.app.Application

class MySafeApp : Application() {
    lateinit var vault: VaultManager
        private set

    override fun onCreate() {
        super.onCreate()
        vault = VaultManager(this)
    }
}

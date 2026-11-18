// The Android app module is only included when an Android SDK is present
// (CI, or a developer machine). vaultcore is plain JVM and always builds.
val androidSdk = System.getenv("ANDROID_HOME") != null || System.getenv("ANDROID_SDK_ROOT") != null

pluginManagement {
    val hasSdk = System.getenv("ANDROID_HOME") != null || System.getenv("ANDROID_SDK_ROOT") != null
    repositories {
        if (hasSdk) google()
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    val hasSdk = System.getenv("ANDROID_HOME") != null || System.getenv("ANDROID_SDK_ROOT") != null
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        if (hasSdk) google()
        mavenCentral()
    }
}

rootProject.name = "My-Safe"
include(":vaultcore")
if (androidSdk) include(":app")

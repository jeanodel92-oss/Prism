package space.odelserver.prism.mobile

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

// Copied over the generated activity by scripts/build.sh (the generated Android project is not kept in Git).
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // No grey scrim over the gesture or button bar: it takes the page's colour like the status bar (systemBars below).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false
    // Android draws apps under the system bars; WebView 133 gives the page no inset at the bottom, so the composer sat
    // under the navigation bar. The content is padded instead, keyboard included.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { view, insets ->
      val around = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(around.left, around.top, around.right, around.bottom)
      WindowInsetsCompat.CONSUMED
    }
    if (keepLink()) startLinkService()
  }

  // The app closed for good (swiped away): no window, no link to keep.
  override fun onDestroy() {
    if (isFinishing) stopService(Intent(this, LinkService::class.java))
    super.onDestroy()
  }

  private fun keepLink(): Boolean = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEEP_LINK, true)

  private fun startLinkService() {
    // Android 13 and later ask before an app shows notifications; refused, the link is still kept, without the notice.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    ContextCompat.startForegroundService(this, Intent(this, LinkService::class.java))
  }

  private var web: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    web = webView
    webView.addJavascriptInterface(SystemBars(), "PrismAndroid")
  }

  // Called by the page's theme (fork/gui/ui/js/theme.js) each time it changes: the padding around the page, under the
  // status and navigation bars, takes the page's background, and the bars' icons stay readable on it.
  inner class SystemBars {
    @JavascriptInterface
    fun systemBars(color: String, light: Boolean) {
      val parsed = try {
        Color.parseColor(color)
      } catch (_: IllegalArgumentException) {
        return
      }
      runOnUiThread {
        findViewById<View>(android.R.id.content).setBackgroundColor(parsed)
        WindowCompat.getInsetsController(window, window.decorView).apply {
          isAppearanceLightStatusBars = light
          isAppearanceLightNavigationBars = light
        }
      }
    }

    // The settings' switch (fork/gui/ui/js/pair-screen.js): the permanent notification that keeps the link up.
    @JavascriptInterface
    fun keepLinkEnabled(): Boolean = keepLink()

    @JavascriptInterface
    fun setKeepLink(on: Boolean) {
      getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEEP_LINK, on).apply()
      runOnUiThread {
        if (on) startLinkService() else stopService(Intent(this@MainActivity, LinkService::class.java))
      }
    }

    // Called by the page (fork/gui/ui/phone/transfer.js) with a file of the PC that the host assembled in the app's cache
    // (download_* in src-tauri/src/lib.rs): saved in the phone's Downloads, and shown by the app that opens it when `open`.
    // Returns "" when done, else the reason. Only a file of the app's own downloads folder is taken.
    @JavascriptInterface
    fun saveDownload(path: String, name: String, open: Boolean): String {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "Saving a file needs Android 10 or later."
      val source = try {
        File(path).canonicalFile
      } catch (_: java.io.IOException) {
        return "Not a downloaded file."
      }
      val cache = cacheDir.canonicalPath + File.separator
      if (!source.path.startsWith(cache) || !source.path.contains(File.separator + "downloads" + File.separator) || !source.isFile) {
        return "Not a downloaded file."
      }
      val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(source.extension.lowercase()) ?: "application/octet-stream"
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, name)
        put(MediaStore.Downloads.MIME_TYPE, mime)
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val resolver = contentResolver
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return "Cannot create the file in Downloads."
      try {
        resolver.openOutputStream(uri)?.use { out -> source.inputStream().use { it.copyTo(out) } }
          ?: throw java.io.IOException("Cannot write the file in Downloads.")
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
      } catch (e: java.io.IOException) {
        resolver.delete(uri, null, null)
        return e.message ?: "Cannot save the file."
      } finally {
        source.delete()
        source.parentFile?.delete()
      }
      if (open) {
        try {
          startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
          )
        } catch (_: ActivityNotFoundException) {
          return "No app on the phone opens this file; it is saved in Downloads."
        }
      }
      return ""
    }

    // Called by the page's link dialog (fork/gui/ui/js/app.js confirmLink) once the user chose to open the link: the
    // phone's browser opens it. Web links only, as the window's open_external.
    @JavascriptInterface
    fun openUrl(url: String) {
      val uri = Uri.parse(url)
      if (uri.scheme !in listOf("http", "https")) return
      runOnUiThread {
        try {
          startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
          // No app opens it: nothing to do, the dialog already showed the address.
        }
      }
    }

    // the app's own version, which the Prism release names
    // (fork/scripts/release.sh), and the latest stable release on the site, for fork/gui/ui/js/android-update.js.
    @JavascriptInterface
    fun appVersion(): String = try {
      packageManager.getPackageInfo(packageName, 0).versionName ?: ""
    } catch (_: PackageManager.NameNotFoundException) {
      ""
    }

    // Returns at once; the answer comes as a "prism-latest" event on the page: the version, or "" when the site could
    // not be reached. The page's own requests stay limited to the app (its content security policy).
    @JavascriptInterface
    fun checkLatest() {
      Thread {
        val latest = try {
          val connection = URL(LATEST_URL).openConnection() as HttpURLConnection
          connection.connectTimeout = 5000
          connection.readTimeout = 5000
          try {
            if (connection.responseCode == 200) {
              connection.inputStream.bufferedReader().use { it.readLine() ?: "" }.trim()
            } else {
              ""
            }
          } finally {
            connection.disconnect()
          }
        } catch (_: Exception) {
          ""
        }
        // A stable release name only: the APK is published with stable releases (no canary APK).
        val valid = if (Regex("^[0-9A-Za-z.+-]+$").matches(latest) && !latest.contains(".canary.")) latest else ""
        runOnUiThread {
          web?.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('prism-latest', { detail: ${JSONObject.quote(valid)} }))",
            null,
          )
        }
      }.start()
    }
  }

  companion object {
    const val PREFS = "prism"
    const val KEEP_LINK = "keepLink"
    const val LATEST_URL = "https://prism.odelserver.space/releases/LATEST"
  }
}

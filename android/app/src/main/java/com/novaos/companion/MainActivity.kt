package com.novaos.companion

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.Locale

class MainActivity : ComponentActivity() {
    private val client = OkHttpClient()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { NovaCompanionApp(client) }
    }
}

@Composable
fun NovaCompanionApp(client: OkHttpClient) {
    var host by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var paired by remember { mutableStateOf(false) }
    var cloudMode by remember { mutableStateOf(false) }
    var command by remember { mutableStateOf("") }
    var replies by remember { mutableStateOf(listOf<String>()) }
    var log by remember { mutableStateOf(listOf<String>()) }

    val scope = rememberCoroutineScope()

    fun sendCommand(text: String) {
        if (text.isBlank()) return
        replies = replies + "You: $text"
        if (cloudMode || !paired) {
            replies = replies + "Nova: (cloud fallback) $text"
            return
        }
        scope.launch(Dispatchers.IO) {
            try {
                val body = JSONObject().put("action", "run").put("text", text).toString()
                val req = Request.Builder()
                    .url("http://$host/action")
                    .addHeader("X-Nova-Token", token)
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                val resp = client.newCall(req).execute()
                val txt = resp.body?.string() ?: ""
                withContext(Dispatchers.Main) {
                    replies = replies + "Nova: $txt"
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    replies = replies + "Nova: error ${e.message}"
                }
            }
        }
    }

    MaterialTheme(colorScheme = darkColorScheme()) {
        Surface(modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("NOVA // OS Companion", style = MaterialTheme.typography.headlineSmall, fontFamily = FontFamily.Monospace)
                if (!paired && !cloudMode) {
                    OutlinedTextField(value = host, onValueChange = { host = it }, label = { Text("Host (IP:PORT)") })
                    OutlinedTextField(value = token, onValueChange = { token = it }, label = { Text("Token") })
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { paired = host.isNotBlank() && token.isNotBlank() }) { Text("Pair") }
                        Button(onClick = { cloudMode = true }) { Text("Cloud Fallback") }
                    }
                    Text("Scan the QR code from Desktop Settings, or enter manually.", style = MaterialTheme.typography.bodySmall)
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(if (cloudMode) "Mode: Cloud" else "Paired: $host", fontFamily = FontFamily.Monospace)
                        if (cloudMode) Button(onClick = { cloudMode = false; paired = false }) { Text("Unpair") }
                    }
                    OutlinedTextField(value = command, onValueChange = { command = it }, label = { Text("Command") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { sendCommand(command); command = "" }) { Text("Send") }
                        Button(onClick = {
                            // voice input placeholder
                        }) { Text("Voice") }
                    }
                    Text("Replies", fontFamily = FontFamily.Monospace)
                    replies.takeLast(10).forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                    Text("Action Log", fontFamily = FontFamily.Monospace)
                    log.takeLast(10).forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
    }
}
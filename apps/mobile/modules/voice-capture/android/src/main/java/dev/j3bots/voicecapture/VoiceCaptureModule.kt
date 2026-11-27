// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.voicecapture

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The rate the voice socket takes (`VOICE_SAMPLE_RATE` in packages/contracts). */
private const val SAMPLE_RATE = 16_000

/** One piece of the recording: a tenth of a second. */
private const val PIECE_SAMPLES = SAMPLE_RATE / 10

/**
 * The microphone for dictation through the server (decision 0096): mono,
 * 16 kHz, 32-bit float PCM, read a piece at a time as little-endian bytes,
 * which is what the voice socket takes. Nothing is kept: each piece goes
 * to the app and is gone from here.
 *
 * `start` opens the microphone, once the operator allowed it, and answers
 * whether it is recording. `read` answers the next piece, about 100 ms, as
 * soon as it is recorded, or null once the recording stopped or the
 * microphone failed. `stop` lets the microphone go; so does the module's end.
 *
 * The recorder is set up as T3 Code's is (`v0.1.13`,
 * `apps/mobile/modules/t3-voice-transcription/android/src/main/java/expo/modules/t3voicetranscription/LiveVoiceRecorder.kt`,
 * MIT): the voice recognition source, 16 kHz mono, a buffer of at least a
 * second, and a blocking read that `stop` ends.
 */
class VoiceCaptureModule : Module() {
  @Volatile private var recording: Recording? = null

  override fun definition() = ModuleDefinition {
    Name("VoiceCapture")

    Function("start") { -> start() }

    // The read blocks until a piece is recorded, so it waits off the modules' queue.
    AsyncFunction("read") Coroutine { ->
      val current = recording
      if (current == null) null else withContext(Dispatchers.IO) { current.read() }
    }

    Function("stop") { stop() }

    OnDestroy { stop() }
  }

  // The permission is checked first: the recorder is made only once the operator allowed it.
  @SuppressLint("MissingPermission")
  private fun start(): Boolean {
    stop()
    val context = appContext.reactContext ?: return false
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      return false
    }
    val least = AudioRecord.getMinBufferSize(
      SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_FLOAT,
    )
    if (least <= 0) return false
    val record = try {
      AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_FLOAT,
        maxOf(least, SAMPLE_RATE * 4),
      )
    } catch (error: IllegalArgumentException) {
      return false
    }
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      return false
    }
    try {
      record.startRecording()
    } catch (error: IllegalStateException) {
      record.release()
      return false
    }
    if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
      record.release()
      return false
    }
    recording = Recording(record)
    return true
  }

  private fun stop() {
    recording?.stop()
    recording = null
  }
}

/**
 * One recording, from `start` to `stop`. A read may be waiting on the
 * recorder when `stop` comes: stopping the recorder ends that read, which
 * then lets the recorder go, so it is never released under a read.
 */
private class Recording(private val record: AudioRecord) {
  private val lock = Any()
  private var reading = false
  private var stopped = false

  fun read(): ByteArray? {
    synchronized(lock) {
      if (stopped) return null
      reading = true
    }
    val samples = FloatArray(PIECE_SAMPLES)
    val count = try {
      record.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
    } finally {
      synchronized(lock) {
        reading = false
        if (stopped) record.release()
      }
    }
    // Nothing more, or an error code: the recording is over.
    if (count <= 0) return null
    val bytes = ByteBuffer.allocate(count * Float.SIZE_BYTES).order(ByteOrder.LITTLE_ENDIAN)
    bytes.asFloatBuffer().put(samples, 0, count)
    return bytes.array()
  }

  fun stop() {
    synchronized(lock) {
      if (stopped) return
      stopped = true
      runCatching { record.stop() }
      if (!reading) record.release()
    }
  }
}

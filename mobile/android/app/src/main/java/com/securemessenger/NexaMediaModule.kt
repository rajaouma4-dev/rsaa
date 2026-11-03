package com.securemessenger

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import kotlin.math.max
import kotlin.math.min

class NexaMediaModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    private var pickImagesPromise: Promise? = null
    private var mediaRecorder: MediaRecorder? = null
    private var recordingFile: File? = null
    private var recordingStartTime: Long = 0
    private var mediaPlayer: MediaPlayer? = null
    private var currentPlayingUri: String? = null

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName(): String {
        return "NexaMediaModule"
    }

    private fun sendEvent(eventName: String, params: WritableMap?) {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (ignored: Exception) {}
    }

    @ReactMethod
    fun pickImages(promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.reject("E_ACTIVITY_NULL", "Activity does not exist")
            return
        }

        if (pickImagesPromise != null) {
            promise.reject("E_CONCURRENT", "Image picker is already active")
            return
        }

        pickImagesPromise = promise

        try {
            val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                type = "image/*"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                addCategory(Intent.CATEGORY_OPENABLE)
            }
            activity.startActivityForResult(
                Intent.createChooser(intent, "Select Photos"),
                REQUEST_PICK_IMAGES
            )
        } catch (e: Exception) {
            pickImagesPromise = null
            promise.reject("E_PICK_FAILED", e.message, e)
        }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQUEST_PICK_IMAGES) {
            val promise = pickImagesPromise ?: return
            pickImagesPromise = null

            if (resultCode != Activity.RESULT_OK || data == null) {
                // User cancelled or no selection
                val emptyArray = Arguments.createArray()
                promise.resolve(emptyArray)
                return
            }

            val uris = Arguments.createArray()
            val clipData = data.clipData
            if (clipData != null) {
                for (i in 0 until clipData.itemCount) {
                    val uri = clipData.getItemAt(i).uri
                    uris.pushString(uri.toString())
                }
            } else if (data.data != null) {
                uris.pushString(data.data.toString())
            }

            promise.resolve(uris)
        }
    }

    override fun onNewIntent(intent: Intent) {}

    @ReactMethod
    fun processAvatar(uriString: String, promise: Promise) {
        Thread {
            val allocated = mutableListOf<Bitmap>()
            try {
                val uri=Uri.parse(uriString);val resolver=reactContext.contentResolver
                val bounds=BitmapFactory.Options().apply { inJustDecodeBounds=true }
                resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it,null,bounds) }
                require(bounds.outWidth>0 && bounds.outHeight>0) { "Cannot read photo" }
                var sample=1
                while (max(bounds.outWidth,bounds.outHeight)/sample>512) sample*=2
                val options=BitmapFactory.Options().apply {inSampleSize=sample;inPreferredConfig=Bitmap.Config.ARGB_8888}
                val decoded=resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it,null,options) } ?: error("Cannot decode photo")
                allocated.add(decoded)
                val orientation=resolver.openInputStream(uri).use { input ->
                    if(input==null) 1 else try {android.media.ExifInterface(input).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION,1)} catch (_:Exception){1}
                }
                val matrix=android.graphics.Matrix()
                when(orientation){3->matrix.postRotate(180f);6->matrix.postRotate(90f);8->matrix.postRotate(270f);2->matrix.postScale(-1f,1f);4->matrix.postScale(1f,-1f);5->{matrix.postRotate(90f);matrix.postScale(-1f,1f)};7->{matrix.postRotate(270f);matrix.postScale(-1f,1f)}}
                val rotated=Bitmap.createBitmap(decoded,0,0,decoded.width,decoded.height,matrix,true);allocated.add(rotated)
                val side=min(rotated.width,rotated.height)
                val crop=Bitmap.createBitmap(rotated,(rotated.width-side)/2,(rotated.height-side)/2,side,side);allocated.add(crop)
                var size=min(256,side);var photo=Bitmap.createScaledBitmap(crop,size,size,true);allocated.add(photo)
                var bytes:ByteArray
                while(true){
                    val output=ByteArrayOutputStream();photo.compress(Bitmap.CompressFormat.JPEG,72,output);bytes=output.toByteArray()
                    if(bytes.size<=16000)break
                    size=(size*.8).toInt().coerceAtLeast(32)
                    photo=Bitmap.createScaledBitmap(crop,size,size,true);allocated.add(photo)
                    if(size==32){val tiny=ByteArrayOutputStream();photo.compress(Bitmap.CompressFormat.JPEG,50,tiny);bytes=tiny.toByteArray();break}
                }
                require(bytes.size<=16000){"Photo could not be compressed"}
                promise.resolve("data:image/jpeg;base64,"+Base64.encodeToString(bytes,Base64.NO_WRAP))
            } catch(e:Exception){promise.reject("E_AVATAR",e.message,e)}
            finally{allocated.distinct().forEach{if(!it.isRecycled)it.recycle()}}
        }.start()
    }

    @ReactMethod
    fun processImage(uriString: String, isHd: Boolean, promise: Promise) {
        Thread {
            try {
                val uri = Uri.parse(uriString)
                val resolver = reactContext.contentResolver

                // 1. Get original dimensions without loading full pixels
                var inputStream: InputStream? = resolver.openInputStream(uri)
                val options = BitmapFactory.Options().apply {
                    inJustDecodeBounds = true
                }
                BitmapFactory.decodeStream(inputStream, null, options)
                inputStream?.close()

                val origWidth = options.outWidth
                val origHeight = options.outHeight
                if (origWidth <= 0 || origHeight <= 0) {
                    promise.reject("E_INVALID_IMAGE", "Cannot decode image dimensions")
                    return@Thread
                }

                // 2. Decode full image with appropriate downsampling
                val maxFullDim = if (isHd) 1920 else 960
                var sampleSize = 1
                var w = origWidth
                var h = origHeight
                while (w / 2 >= maxFullDim || h / 2 >= maxFullDim) {
                    w /= 2
                    h /= 2
                    sampleSize *= 2
                }

                val decodeOptions = BitmapFactory.Options().apply {
                    inSampleSize = sampleSize
                    inPreferredConfig = Bitmap.Config.RGB_565 // Memory-friendly
                }

                inputStream = resolver.openInputStream(uri)
                val decodedBitmap = BitmapFactory.decodeStream(inputStream, null, decodeOptions)
                inputStream?.close()

                if (decodedBitmap == null) {
                    promise.reject("E_DECODE_FAILED", "Failed to decode bitmap")
                    return@Thread
                }

                // Scale accurately to target bounding box
                val scale = min(1.0f, maxFullDim.toFloat() / max(decodedBitmap.width, decodedBitmap.height))
                val targetWidth = (decodedBitmap.width * scale).toInt().coerceAtLeast(1)
                val targetHeight = (decodedBitmap.height * scale).toInt().coerceAtLeast(1)

                val fullBitmap = if (scale < 1.0f) {
                    Bitmap.createScaledBitmap(decodedBitmap, targetWidth, targetHeight, true)
                } else {
                    decodedBitmap
                }

                // Compress Full image to Base64
                val fullStream = ByteArrayOutputStream()
                val quality = if (isHd) 84 else 68
                fullBitmap.compress(Bitmap.CompressFormat.JPEG, quality, fullStream)
                val fullBytes = fullStream.toByteArray()
                val fullBase64 = Base64.encodeToString(fullBytes, Base64.NO_WRAP)
                fullStream.close()

                // 3. Generate crisp high-DPI thumbnail for zero-lag chat rendering & razor-sharp bubble view
                val maxThumbDim = 256
                val thumbScale = min(1.0f, maxThumbDim.toFloat() / max(fullBitmap.width, fullBitmap.height))
                val thumbWidth = (fullBitmap.width * thumbScale).toInt().coerceAtLeast(1)
                val thumbHeight = (fullBitmap.height * thumbScale).toInt().coerceAtLeast(1)

                val thumbBitmap = Bitmap.createScaledBitmap(fullBitmap, thumbWidth, thumbHeight, true)
                val thumbStream = ByteArrayOutputStream()
                thumbBitmap.compress(Bitmap.CompressFormat.JPEG, 65, thumbStream)
                val thumbBytes = thumbStream.toByteArray()
                val thumbBase64 = "data:image/jpeg;base64," + Base64.encodeToString(thumbBytes, Base64.NO_WRAP)
                thumbStream.close()

                if (fullBitmap != decodedBitmap) {
                    fullBitmap.recycle()
                }
                decodedBitmap.recycle()
                thumbBitmap.recycle()

                val result = Arguments.createMap().apply {
                    putString("thumb", thumbBase64)
                    putString("fullBase64", fullBase64)
                    putInt("width", targetWidth)
                    putInt("height", targetHeight)
                    putBoolean("isHd", isHd)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("E_PROCESS_ERROR", e.message, e)
            }
        }.start()
    }

    @ReactMethod
    fun startRecording(promise: Promise) {
        try {
            stopCurrentRecording()

            val cacheDir = reactContext.cacheDir
            val voiceFile = File(cacheDir, "voice_rec_${System.currentTimeMillis()}.m4a")
            recordingFile = voiceFile

            val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(reactContext)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }

            recorder.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(24000)
                setAudioEncodingBitRate(28000)
                setOutputFile(voiceFile.absolutePath)
                prepare()
                start()
            }

            mediaRecorder = recorder
            recordingStartTime = System.currentTimeMillis()

            promise.resolve(voiceFile.absolutePath)
        } catch (e: Exception) {
            stopCurrentRecording()
            promise.reject("E_RECORD_START", e.message, e)
        }
    }

    @ReactMethod
    fun stopRecording(promise: Promise) {
        val recorder = mediaRecorder
        val file = recordingFile
        val startTime = recordingStartTime

        if (recorder == null || file == null) {
            promise.reject("E_NOT_RECORDING", "No active recording found")
            return
        }

        try {
            recorder.stop()
            recorder.release()
            mediaRecorder = null

            val elapsedMs = System.currentTimeMillis() - startTime
            val durationSec = max(1, (elapsedMs / 1000).toInt())

            Thread {
                try {
                    val fileInputStream = FileInputStream(file)
                    val bytes = fileInputStream.readBytes()
                    fileInputStream.close()

                    val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)

                    val result = Arguments.createMap().apply {
                        putString("audioUri", Uri.fromFile(file).toString())
                        putString("audioBase64", base64)
                        putInt("durationSec", durationSec)
                    }
                    promise.resolve(result)
                } catch (ioErr: Exception) {
                    stopCurrentRecording()
                    promise.reject("E_RECORD_STOP", ioErr.message, ioErr)
                }
            }.start()
        } catch (e: Exception) {
            stopCurrentRecording()
            promise.reject("E_RECORD_STOP", e.message, e)
        }
    }

    @ReactMethod
    fun cancelRecording(promise: Promise) {
        stopCurrentRecording()
        promise.resolve(true)
    }

    private fun stopCurrentRecording() {
        try {
            mediaRecorder?.stop()
        } catch (ignored: Exception) {}
        try {
            mediaRecorder?.release()
        } catch (ignored: Exception) {}
        mediaRecorder = null

        try {
            recordingFile?.delete()
        } catch (ignored: Exception) {}
        recordingFile = null
    }

    @ReactMethod
    fun playVoice(audioSource: String, promise: Promise) {
        try {
            stopAudio()

            val player = MediaPlayer()
            var targetFile: File? = null

            if (audioSource.startsWith("content://") || audioSource.startsWith("file://")) {
                player.setDataSource(reactContext, Uri.parse(audioSource))
            } else {
                // Base64 audio string
                val cleanBase64 = if (audioSource.contains(",")) audioSource.substringAfter(",") else audioSource
                val bytes = Base64.decode(cleanBase64, Base64.DEFAULT)
                targetFile = File(reactContext.cacheDir, "play_voice_${System.currentTimeMillis()}.m4a")
                FileOutputStream(targetFile).use { it.write(bytes) }
                player.setDataSource(targetFile.absolutePath)
            }

            player.setOnCompletionListener {
                val params = Arguments.createMap().apply {
                    putString("event", "completed")
                }
                sendEvent("onVoicePlaybackEnd", params)
                stopAudio()
            }

            player.setOnErrorListener { _, what, extra ->
                val params = Arguments.createMap().apply {
                    putString("event", "error")
                    putInt("what", what)
                    putInt("extra", extra)
                }
                sendEvent("onVoicePlaybackEnd", params)
                stopAudio()
                true
            }

            player.prepare()
            player.start()
            mediaPlayer = player
            currentPlayingUri = audioSource

            promise.resolve(player.duration / 1000)
        } catch (e: Exception) {
            stopAudio()
            promise.reject("E_PLAY_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun stopVoice(promise: Promise) {
        stopAudio()
        promise.resolve(true)
    }

    private fun stopAudio() {
        try {
            mediaPlayer?.stop()
        } catch (ignored: Exception) {}
        try {
            mediaPlayer?.release()
        } catch (ignored: Exception) {}
        mediaPlayer = null
        currentPlayingUri = null
    }

    @ReactMethod
    fun saveImagesToGallery(base64Images: ReadableArray, promise: Promise) {
        Thread {
            try {
                var savedCount = 0
                val resolver = reactContext.contentResolver

                for (i in 0 until base64Images.size()) {
                    val raw = base64Images.getString(i) ?: continue
                    val cleanBase64 = if (raw.contains(",")) raw.substringAfter(",") else raw
                    val bytes = Base64.decode(cleanBase64, Base64.DEFAULT)

                    val filename = "Nexa_${System.currentTimeMillis()}_$i.jpg"

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        val contentValues = ContentValues().apply {
                            put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
                            put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
                            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Nexa")
                            put(MediaStore.MediaColumns.IS_PENDING, 1)
                        }

                        val imageUri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues)
                        if (imageUri != null) {
                            resolver.openOutputStream(imageUri)?.use { output ->
                                output.write(bytes)
                            }
                            contentValues.clear()
                            contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0)
                            resolver.update(imageUri, contentValues, null, null)
                            savedCount++
                        }
                    } else {
                        @Suppress("DEPRECATION")
                        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Nexa")
                        if (!dir.exists()) dir.mkdirs()
                        val file = File(dir, filename)
                        FileOutputStream(file).use { it.write(bytes) }
                        
                        @Suppress("DEPRECATION")
                        val intent = Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE).apply {
                            data = Uri.fromFile(file)
                        }
                        reactContext.sendBroadcast(intent)
                        savedCount++
                    }
                }

                promise.resolve(savedCount)
            } catch (e: Exception) {
                promise.reject("E_SAVE_GALLERY", e.message, e)
            }
        }.start()
    }

    companion object {
        private const val REQUEST_PICK_IMAGES = 4920
    }
}

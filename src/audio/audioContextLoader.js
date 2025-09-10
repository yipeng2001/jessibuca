import Emitter from "../utils/emitter";
import {AUDIO_ENC_TYPE, AUDIO_SYNC_VIDEO_DIFF, EVENTS, VIDEO_ENC_TYPE} from "../constant";
import {clamp, noop} from "../utils";

// 总结：这段代码主要完成了音频播放系统的初始化工作，包括创建必要的音频节点、建立音频处理链路、初始化各种状态标志和配置参数，为后续的音频播放和音视频同步做准备。
export default class AudioContextLoader extends Emitter {
    constructor(player) {
        super();
        this.bufferList = [];
        this.player = player;
        this.scriptNode = null;
        this.hasInitScriptNode = false;
        this.audioContextChannel = null;

        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        // 音量控制节点
        this.gainNode = this.audioContext.createGain();
        // Get an AudioBufferSourceNode.
        // This is the AudioNode to use when we want to play an AudioBuffer
        // 这是用于播放 AudioBuffer 时需要使用的 AudioNode
        const source = this.audioContext.createBufferSource();
        
        // set the buffer in the AudioBufferSourceNode 
        // // 在 AudioBufferSourceNode 中设置缓冲区
        source.buffer = this.audioContext.createBuffer(1, 1, 22050);
        // connect the AudioBufferSourceNode to the
        // destination so we can hear the sound
        // 将 AudioBufferSourceNode 连接到 destination
// 这样我们才能听到声音
        source.connect(this.audioContext.destination);
        // noteOn as start
        // start the source playing  开始播放源
        if (source.noteOn) {
            source.noteOn(0);
        } else {
            source.start(0);
        }
        this.audioBufferSourceNode = source;
      // 创建媒体流音频目标节点
        this.mediaStreamAudioDestinationNode = this.audioContext.createMediaStreamDestination();
        //启用音频
        this.audioEnabled(true);
        // default setting 0
        this.gainNode.gain.value = 0;
        this._prevVolume = null;
        // 初始化音量为 0（静音状态），并初始化上一次音量记录为 null。
        this.playing = false;
        //音频视频同步选项 初始化音视频同步配置对象，diff 用于记录音视频时间差。
        this.audioSyncVideoOption = {
            diff: null
        };

// 音频信息对象
        this.audioInfo = {
            encType: '',      // 编码类型
            channels: '',     // 声道数
            sampleRate: ''    // 采样率
        }
        this.init = false;
        this.hasAudio = false;

        // update
        this.on(EVENTS.videoSyncAudio, (options) => {
            // this.player.debug.log('AudioContext', `videoSyncAudio , audioTimestamp: ${options.audioTimestamp},videoTimestamp: ${options.videoTimestamp},diff:${options.diff}`)
            this.audioSyncVideoOption = options;
        })

        this.player.debug.log('AudioContext', 'init');
    }

    resetInit() {
        this.init = false;
        this.audioInfo = {
            encType: '',
            channels: '',
            sampleRate: ''
        }
    }


    async destroy() {
        this.closeAudio();
        this.resetInit();
        if (this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
        }

        this.gainNode = null;
        this.hasAudio = false;
        this.playing = false;
        if (this.scriptNode) {
            this.scriptNode.onaudioprocess = noop;
            this.scriptNode = null;
        }
        this.audioBufferSourceNode = null;
        this.mediaStreamAudioDestinationNode = null;
        this.hasInitScriptNode = false;
        this.audioSyncVideoOption = {
            diff: null
        };
        this._prevVolume = null;
        this.off();
        this.player.debug.log('AudioContext', 'destroy');
    }

    updateAudioInfo(data) {
        if (data.encTypeCode) {
            this.audioInfo.encType = AUDIO_ENC_TYPE[data.encTypeCode];
            this.audioInfo.encTypeCode = data.encTypeCode;
        }

        if (data.channels) {
            this.audioInfo.channels = data.channels;
        }

        if (data.sampleRate) {
            this.audioInfo.sampleRate = data.sampleRate;
        }

        // audio 基本信息
        if (this.audioInfo.sampleRate && this.audioInfo.channels && this.audioInfo.encType && !this.init) {
            this.player.emit(EVENTS.audioInfo, this.audioInfo);
            this.init = true;
        }
    }

    //
    get isPlaying() {
        return this.playing;
    }

    get isMute() {
        return this.gainNode.gain.value === 0;
    }

    get volume() {
        return this.gainNode.gain.value;
    }

    get bufferSize() {
        return this.bufferList.length;
    }


    initScriptNode() {
        this.playing = true;

        if (this.hasInitScriptNode) {
            return;
        }
        const channels = this.audioInfo.channels;
// 5. ScriptProcessorNode - 音频处理节点（已废弃，但仍在使用）
        const scriptNode = this.audioContext.createScriptProcessor(1024, 0, channels);
        // tips: if audio isStateSuspended  onaudioprocess method not working
        scriptNode.onaudioprocess = (audioProcessingEvent) => {
            const outputBuffer = audioProcessingEvent.outputBuffer;

            if (this.bufferList.length && this.playing) {
                // just for wasm
                if (!this.player._opt.useWCS && !this.player._opt.useMSE && this.player._opt.wasmDecodeAudioSyncVideo) {
                    // audio > video
                    // wait
                    if (this.audioSyncVideoOption.diff > AUDIO_SYNC_VIDEO_DIFF) {
                        this.player.debug.warn('AudioContext', `audioSyncVideoOption more than diff :${this.audioSyncVideoOption.diff}, waiting`)
                        // wait
                        return;
                    }
                        // audio < video
                    // throw away then chase video
                    else if (this.audioSyncVideoOption.diff < -AUDIO_SYNC_VIDEO_DIFF) {
                        this.player.debug.warn('AudioContext', `audioSyncVideoOption less than diff :${this.audioSyncVideoOption.diff}, dropping`)

                        //
                        let bufferItem = this.bufferList.shift();
                        //
                        while ((bufferItem.ts - this.player.videoTimestamp < -AUDIO_SYNC_VIDEO_DIFF) && this.bufferList.length > 0) {
                            // this.player.debug.warn('AudioContext', `audioSyncVideoOption less than inner ts is:${bufferItem.ts}, videoTimestamp is ${this.player.videoTimestamp},diff:${bufferItem.ts - this.player.videoTimestamp}`)
                            bufferItem = this.bufferList.shift();
                        }

                        if (this.bufferList.length === 0) {
                            return;
                        }
                    }
                }

                if (this.bufferList.length === 0) {
                    return;
                }

                const bufferItem = this.bufferList.shift();

                // update audio time stamp
                if (bufferItem && bufferItem.ts) {
                    this.player.audioTimestamp = bufferItem.ts;
                }

                for (let channel = 0; channel < channels; channel++) {
                    const b = bufferItem.buffer[channel]
                    const nowBuffering = outputBuffer.getChannelData(channel);
                    for (let i = 0; i < 1024; i++) {
                        nowBuffering[i] = b[i] || 0
                    }
                }
            }
        }

        scriptNode.connect(this.gainNode);
        this.scriptNode = scriptNode;
        this.gainNode.connect(this.audioContext.destination);
        // 6. MediaStreamDestination - 创建媒体流输出
        this.gainNode.connect(this.mediaStreamAudioDestinationNode);
        this.hasInitScriptNode = true;
    }

    mute(flag) {
        if (flag) {
            // if (!this.isMute) {
            //     this.player.emit(EVENTS.mute, flag);
            // }
            this.setVolume(0);
            this.clear();
        } else {
            // if (this.isMute) {
            //     this.player.emit(EVENTS.mute, flag);
            // }
            this.setVolume(0.5);
        }
    }

    setVolume(volume) {
        volume = parseFloat(volume).toFixed(2);
        if (isNaN(volume)) {
            return;
        }
        this.audioEnabled(true);
        volume = clamp(volume, 0, 1);
        if (this._prevVolume === null) {
            this.player.emit(EVENTS.mute, volume === 0);
        } else {
            if (this._prevVolume === 0 && volume > 0) {
                this.player.emit(EVENTS.mute, false);
            } else if (this._prevVolume > 0 && volume === 0) {
                this.player.emit(EVENTS.mute, true);
            }
        }
        this.gainNode.gain.value = volume;
        this.gainNode.gain.setValueAtTime(volume, this.audioContext.currentTime);
        this.player.emit(EVENTS.volumechange, this.player.volume);
        this.player.emit(EVENTS.volume, this.player.volume); // outer
        // save last volume
        this._prevVolume = volume;
    }

    closeAudio() {
        if (this.hasInitScriptNode) {
            this.scriptNode && this.scriptNode.disconnect(this.gainNode);
            this.gainNode && this.gainNode.disconnect(this.audioContext.destination);
            this.gainNode && this.gainNode.disconnect(this.mediaStreamAudioDestinationNode);
        }
        this.clear();
    }

    // 是否播放。。。
    audioEnabled(flag) {
        if (flag) {
            if (this.audioContext.state === 'suspended') {
                // resume
                this.audioContext.resume();
            }
        } else {
            if (this.audioContext.state === 'running') {
                // suspend
                this.audioContext.suspend();
            }
        }
    }

    isStateRunning() {
        return this.audioContext.state === 'running';
    }

    isStateSuspended() {
        return this.audioContext.state === 'suspended';
    }

    clear() {
        this.bufferList = [];
    }

    play(buffer, ts) {
        // if is mute
        if (this.isMute) {
            return;
        }

        this.hasAudio = true;

        this.bufferList.push({
            buffer,
            ts
        });

        if (this.bufferList.length > 20) {
            this.player.debug.warn('AudioContext', `bufferList is large: ${this.bufferList.length}`)

            // out of memory
            if (this.bufferList.length > 50) {
                this.bufferList.shift();
            }
        }
        // this.player.debug.log('AudioContext', `bufferList is ${this.bufferList.length}`)
    }

    pause() {
        this.audioSyncVideoOption = {
            diff: null
        };
        this.playing = false;
        this.clear();
    }

    resume() {
        this.playing = true;
    }

    getLastVolume() {
        return this._prevVolume;
    }
}

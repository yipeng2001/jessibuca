#ifdef EDITTIME
#undef __cplusplus
#define __cplusplus 201703L
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string>
#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
using namespace std;
using namespace emscripten;
typedef unsigned char u8;
typedef unsigned int u32;
#define PROP(name, type)         \
    type name;                   \
    val get##name() const        \
    {                            \
        return val(name);        \
    }                            \
    void set##name(val value)    \
    {                            \
        name = value.as<type>(); \
    }

extern "C"
{
#include <libavcodec/avcodec.h>
#include <libswresample/swresample.h>
}
class FFmpeg
{
public:
    AVCodec *codec = nullptr;
    AVCodecParserContext *parser = nullptr;
    AVCodecContext *dec_ctx = nullptr;
    AVFrame *frame;
    AVPacket *pkt;
    val jsObject;
    bool initialized = false;
    FFmpeg(val &&v) : jsObject(forward<val>(v))
    {
        pkt = av_packet_alloc();
        frame = av_frame_alloc();
    }
    void initCodec(enum AVCodecID id)
    {
        if (dec_ctx != nullptr)
        {
            clear();
        }
        codec = avcodec_find_decoder(id);
        parser = av_parser_init(codec->id);
        dec_ctx = avcodec_alloc_context3(codec);
    }
    void initCodec(enum AVCodecID id, string input)
    {
        initCodec(id);
        dec_ctx->extradata_size = input.length();
        dec_ctx->extradata = (u8 *)input.data();
        // // dec_ctx->extradata = (u8 *)malloc(dec_ctx->extradata_size);
        // // memcpy(dec_ctx->extradata, input.c_str(), dec_ctx->extradata_size);
        avcodec_open2(dec_ctx, codec, NULL);
        initialized = true;
    }
    virtual ~FFmpeg()
    {
        clear();
        av_frame_free(&frame);
        av_packet_free(&pkt);
    }
    virtual int decode(string input, u32 timestamp)
    {
        int ret = 0;
        pkt->data = (u8 *)(input.data());
        pkt->size = input.length();
        ret = avcodec_send_packet(dec_ctx, pkt);
        while (ret >= 0)
        {
            ret = avcodec_receive_frame(dec_ctx, frame);
            if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF)
                return 0;
            _decode(timestamp);
        }
        return 0;
    }
    virtual void _decode(u32 timestamp){};
    void clear()
    {
        av_parser_close(parser);
        parser = nullptr;
        avcodec_free_context(&dec_ctx);

        codec = nullptr;
        initialized = false;
    }
};

class FFmpegAudioDecoder : public FFmpeg
{
    SwrContext *au_convert_ctx = nullptr;
    u8 *out_buffer[2];
    int output_nb_samples;
    int n_channel;

public:
    PROP(sample_rate, int)
    //    struct SwrContext *au_convert_ctx = nullptr;
    FFmpegAudioDecoder(val &&v) : FFmpeg(move(v))
    {
        //        emscripten_log(0, "FFMpegAudioDecoder init");
    }
    ~FFmpegAudioDecoder()
    {
        if (au_convert_ctx)
            swr_free(&au_convert_ctx);
        if (out_buffer[0]) 
            free(out_buffer[0]);
        //        emscripten_log(0, "FFMpegAudioDecoder destory");
    }
    int decode(string input, u32 timestamp) override
    {
        u8 flag = (u8)input[0];
        u8 audioType = flag >> 4;
        if (initialized)
        {
            return FFmpeg::decode(input.substr(audioType == 10 ? 2 : 1), timestamp);
        }
        else
        {
            jsObject.call<void>("setAudioCodec", audioType);
            switch (audioType)
            {
            case 10:
                if (!input[1])
                {
                    initCodec(AV_CODEC_ID_AAC, input.substr(2));
                    n_channel = 2;
                }
                break;
            case 7:
            // 音频编解码器初始化部分 初始化 PCM A-Law 编解码器（电话质量音频，常用于VoIP）。
                initCodec(AV_CODEC_ID_PCM_ALAW);
                dec_ctx->channel_layout = AV_CH_LAYOUT_MONO;
                dec_ctx->sample_rate = 8000; //8000Hz 采样率（电话质量）
                dec_ctx->channels = 1; //单声道布局
                avcodec_open2(dec_ctx, codec, NULL); //打开解码器，记录声道数，标记初始化完成。
                n_channel = 1;//1个声道
                initialized = true;
                break;
            case 8:
                initCodec(AV_CODEC_ID_PCM_MULAW);
                dec_ctx->channel_layout = AV_CH_LAYOUT_MONO;
                dec_ctx->sample_rate = 8000;
                dec_ctx->channels = 1;
                avcodec_open2(dec_ctx, codec, NULL);
                n_channel = 1;
                initialized = true;
                break;
            default:
                //                emscripten_log(0, "audio type not support:%d", audioType);
                break;
            }
            if (initialized)
            {
                jsObject.call<void>("initAudioPlanar", n_channel, sample_rate);
            }
        }
        return 0;
    }
    void _decode(u32 timestamp) override
    {
        auto nb_samples = frame->nb_samples;
        auto bytes_per_sample = av_get_bytes_per_sample(AV_SAMPLE_FMT_FLTP);
        // 获取音频帧的采样数和每个采样的字节数（FLTP = 浮点平面格式）。
        if (dec_ctx->sample_fmt == AV_SAMPLE_FMT_FLTP && sample_rate == dec_ctx->sample_rate && dec_ctx->channel_layout == n_channel)
        {
            jsObject.call<void>("playAudioPlanar", int(frame->data), nb_samples * bytes_per_sample * n_channel);
            return;
        }
        if (!au_convert_ctx)
        {
            au_convert_ctx = swr_alloc_set_opts(NULL, 
                n_channel == 2 ? AV_CH_LAYOUT_STEREO : AV_CH_LAYOUT_MONO,  // 目标声道布局
                AV_SAMPLE_FMT_FLTP,                                         // 目标格式
                sample_rate,                                                // 目标采样率
                dec_ctx->channel_layout,                                    // 源声道布局
                dec_ctx->sample_fmt,                                        // 源格式
                dec_ctx->sample_rate,                                       // 源采样率
                0, NULL);
            auto ret = swr_init(au_convert_ctx); //初始化重采样器。
            auto out_buffer_size = av_samples_get_buffer_size(NULL, n_channel, nb_samples, AV_SAMPLE_FMT_FLTP, 0);
            auto buffer = (uint8_t *)av_malloc(out_buffer_size);
            // 左声道数据
            out_buffer[0] = buffer;//计算输出缓冲区大小并分配内存。
            // 右声道数据（如果是立体声）
            out_buffer[1] = buffer + (out_buffer_size / 2);
        }
        // 执行音频格式转换
        auto ret = swr_convert(au_convert_ctx, out_buffer, nb_samples, (const uint8_t **)frame->data, nb_samples);
        while (ret > 0)
        {
            /*
            循环处理转换后的音频：发送转换后的数据给 JS 播放
            继续转换剩余数据（如果有）
            第二个 swr_convert 调用用于刷新内部缓冲区
            音频格式说明
                平面格式（Planar）： 平面格式：L L L L... | R R R R...
                平面格式的优势：

                SIMD 优化更容易
                处理单个声道更高效
                Web Audio API 原生支持

            */
            jsObject.call<void>("playAudioPlanar", int(&out_buffer), ret, timestamp);
            ret = swr_convert(au_convert_ctx, out_buffer, nb_samples, (const uint8_t **)frame->data, 0);
        }
    }
};
class FFmpegVideoDecoder : public FFmpeg
{
public:
    u32 videoWidth = 0;
    u32 videoHeight = 0;
    u32 y = 0;
    u32 u = 0;
    u32 v = 0;

    FFmpegVideoDecoder(val &&v) : FFmpeg(move(v))
    {
        //        emscripten_log(0, "FFMpegVideoDecoder init");
    }
    ~FFmpegVideoDecoder()
    {
        //        emscripten_log(0, "FFMpegVideoDecoder destory");
        if (y)
        {
            free((void *)y);
            y = 0;
        }
    }
    int decode(string data, u32 timestamp) override
    {
        int codec_id = ((int)data[0]) & 0x0F;
        if (((int)(data[0]) >> 4) == 1 && data[1] == 0)
        {
            //                emscripten_log(0, "codec = %d", codec_id);
            if (!initialized){
              jsObject.call<void>("setVideoCodec", codec_id);
              switch (codec_id)
              {
              case 7:
                  initCodec(AV_CODEC_ID_H264, data.substr(5));
                  break;
              case 12:
                  initCodec(AV_CODEC_ID_H265, data.substr(5));
                  break;
              default:
                  emscripten_log(0, "codec not support: %d", codec_id);
                  return -1;
              }
            }
        }
        else
        {
            return FFmpeg::decode(data.substr(5), timestamp);
        }
        return 0;
    }
    void _decode(u32 timestamp) override
    {
        if (videoWidth != frame->width || videoHeight != frame->height)
        {
            videoWidth = frame->width;
            videoHeight = frame->height;
            jsObject.call<void>("setVideoSize", videoWidth, videoHeight);
            int size = videoWidth * videoHeight;
            if (y)
                free((void *)y);
            y = (u32)malloc(size * 3 >> 1);
            u = y + size;
            v = u + (size >> 2);
        }
        u32 dst = y;
        for (int i = 0; i < videoHeight; i++)
        {
            memcpy((u8 *)dst, (const u8 *)(frame->data[0] + i * frame->linesize[0]), videoWidth);
            dst += videoWidth;
        }
        dst = u;
        int halfh = videoHeight >> 1;
        int halfw = videoWidth >> 1;
        for (int i = 0; i < halfh; i++)
        {
            memcpy((u8 *)dst, (const u8 *)(frame->data[1] + i * frame->linesize[1]), halfw);
            dst += halfw;
        }

        for (int i = 0; i < halfh; i++)
        {
            memcpy((u8 *)dst, (const u8 *)(frame->data[2] + i * frame->linesize[2]), halfw);
            dst += halfw;
        }
        jsObject.call<void>("draw", timestamp, y, u, v);
    }
};

#define FUNC(name) function(#name, &FFmpegAudioDecoder::name)
#undef PROP
#define PROP(name) property(#name, &FFmpegAudioDecoder::get##name, &FFmpegAudioDecoder::set##name)
EMSCRIPTEN_BINDINGS(FFmpegAudioDecoder)
{
    class_<FFmpegAudioDecoder>("AudioDecoder")
        .constructor<val>()
        .PROP(sample_rate)
        .FUNC(clear)
        .FUNC(decode);
}
#undef FUNC
#define FUNC(name) function(#name, &FFmpegVideoDecoder::name)
#undef PROP
#define PROP(name) property(#name, &FFmpegVideoDecoder::get##name, &FFmpegVideoDecoder::set##name)
EMSCRIPTEN_BINDINGS(FFmpegVideoDecoder)
{
    class_<FFmpegVideoDecoder>("VideoDecoder")
        .constructor<val>()
        .FUNC(clear)
        .FUNC(decode);
}

/*总结
这段代码实现了：

多格式支持：AAC、PCM A-Law、PCM μ-Law
格式统一：将所有音频转换为 FLTP 格式
重采样：支持不同采样率的转换
与 JS 交互：解码后的音频传递给 JavaScript 播放
这是 Jessibuca 播放器 WebAssembly 音频解码的核心实现。*/
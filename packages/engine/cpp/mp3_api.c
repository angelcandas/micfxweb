// mp3.wasm: the desktop's MP3 encoder (LAME, LGPL, in the desktop's libs/lame) for the web's
// takes and exports, with the desktop's settings (src/daw/Mp3Writer.h) and an ID3 tag.
#include <lame.h>
#include <stdlib.h>

// quality: 0..4 constant 128/160/192/256/320 kbps, 5 variable high, 6 variable highest.
lame_global_flags* micfx_mp3_open(int rate, int channels, int quality, const char* title, const char* year, const char* comment)
{
    static const int bitRates[] = { 128, 160, 192, 256, 320 };
    lame_global_flags* flags = lame_init();
    if (!flags) return 0;
    if (quality < 0) quality = 0;
    if (quality > 6) quality = 6;
    lame_set_in_samplerate(flags, rate);
    lame_set_num_channels(flags, channels);
    lame_set_mode(flags, channels == 1 ? MONO : JOINT_STEREO);
    lame_set_quality(flags, 2);
    if (quality < 5) {
        lame_set_VBR(flags, vbr_off);
        lame_set_brate(flags, bitRates[quality]);
    } else {
        lame_set_VBR(flags, vbr_mtrh);
        lame_set_VBR_q(flags, quality == 5 ? 2 : 0);
    }
    id3tag_init(flags);
    id3tag_add_v2(flags);
    if (title && *title) id3tag_set_title(flags, title);
    if (year && *year) id3tag_set_year(flags, year);
    if (comment && *comment) id3tag_set_comment(flags, comment);
    id3tag_set_artist(flags, "");
    if (lame_init_params(flags) < 0) {
        lame_close(flags);
        return 0;
    }
    return flags;
}

// Planar floats in -1..1; the bytes written to out (at least frames * 5 / 4 + 7200 of room).
int micfx_mp3_encode(lame_global_flags* flags, const float* left, const float* right, int frames, unsigned char* out, int size)
{
    return lame_encode_buffer_ieee_float(flags, left, right ? right : left, frames, out, size);
}

int micfx_mp3_finish(lame_global_flags* flags, unsigned char* out, int size)
{
    int n = lame_encode_flush(flags, out, size);
    // The Xing/LAME header in the first frame (lengths for players to seek with VBR) is written
    // by the caller from lame_get_lametag_frame: here it's returned after the tail.
    return n;
}

int micfx_mp3_lametag(lame_global_flags* flags, unsigned char* out, int size)
{
    return (int) lame_get_lametag_frame(flags, out, (size_t) size);
}

void micfx_mp3_close(lame_global_flags* flags)
{
    lame_close(flags);
}

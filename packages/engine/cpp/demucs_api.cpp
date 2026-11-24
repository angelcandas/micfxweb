// stems.wasm: the desktop's stem splitter network (Demucs v4 by demucs.cpp, MIT, on Eigen,
// MPL 2.0), for Web Workers. The weights come from the page (downloaded once, kept in the
// browser's private files); a song is cut into chunks and each Worker separates one at a time.
#include "model.hpp"
#include "model_load.hpp" // demucs.cpp's src_wasm: loads the weights from memory

#include <memory>
#include <streambuf>

// How far a chunk is, 0..1 (the page shows it).
extern "C" __attribute__((import_module ("env"), import_name ("micfx_stems_progress"))) void micfx_stems_progress (float);

namespace
{
    std::unique_ptr<demucscpp::demucs_model> model;

    // demucs.cpp reports as it goes on std::cout: nothing to show here.
    struct Quiet : std::streambuf
    {
        int overflow (int c) override { return c; }
    } quiet;
}

extern "C"
{
    /** The weights (a ggml .bin); the number of stems (4 or 6), or 0 when they didn't load. */
    int micfx_stems_load (const char* data, int size)
    {
        std::cout.rdbuf (&quiet);
        std::cerr.rdbuf (&quiet);
        model = std::make_unique<demucscpp::demucs_model>();
        if (! load_demucs_model_for_wasm (data, (std::size_t) size, model.get()))
        {
            model.reset();
            return 0;
        }
        return model->is_4sources ? 4 : 6;
    }

    /**
     * Separates a stereo chunk at 44.1 kHz. `out` holds stems x 2 x frames floats: each
     * stem's left then right (drums, bass, other, vocals, then guitar and piano for 6).
     */
    int micfx_stems_separate (const float* left, const float* right, int frames, float* out)
    {
        if (model == nullptr || frames <= 0)
            return 0;
        Eigen::MatrixXf audio (2, frames);
        for (int i = 0; i < frames; ++i)
        {
            audio (0, i) = left[i];
            audio (1, i) = right[i];
        }
        const auto result = demucscpp::demucs_inference (*model, audio, [] (float p, const std::string&) { micfx_stems_progress (p); });
        const int stems = model->is_4sources ? 4 : 6;
        const auto length = (int) std::min ((Eigen::Index) frames, (Eigen::Index) result.dimension (2));
        for (int s = 0; s < stems; ++s)
            for (int ch = 0; ch < 2; ++ch)
            {
                auto* to = out + ((std::size_t) s * 2 + (std::size_t) ch) * (std::size_t) frames;
                for (int i = 0; i < frames; ++i)
                    to[i] = i < length ? result (s, ch, i) : 0.0f;
            }
        return stems;
    }
}

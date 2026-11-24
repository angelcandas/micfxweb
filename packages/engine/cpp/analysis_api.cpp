// The C API of analysis.wasm: the desktop's measuring and planning code (src/analysis,
// SoundCheck::makePlan), for a Web Worker. Plain computation: no audio thread, no state
// between calls.
//
// Audio in: the caller copies mono samples into memory from micfx_alloc.
// Strings out: a call returns a length, and the text is at micfx_result (valid until the next call).
#include "SoundCheck.h"

#include <string>
#include <vector>

#define MICFX_EXPORT extern "C" __attribute__ ((used, visibility ("default")))

namespace
{
std::string result;
std::vector<float> noiseProfile;

// Numbers and strings for JSON by hand: JUCE's double-to-text goes through std::ostream,
// which traps in the standalone wasm (see api.cpp).
juce::String fixed (double value, int decimals = 2)
{
    if (! std::isfinite (value))
        return "0";
    const auto scale = std::pow (10.0, decimals);
    auto scaled = (juce::int64) std::llround (std::abs (value) * scale);
    const auto whole = scaled / (juce::int64) scale;
    auto fraction = juce::String (scaled % (juce::int64) scale).paddedLeft ('0', decimals);
    return (value < 0 && scaled != 0 ? "-" : "") + juce::String (whole) + (decimals > 0 ? "." + fraction : juce::String());
}

juce::String quoted (const juce::String& text)
{
    juce::String out ("\"");
    for (auto c : text)
    {
        if (c == '"' || c == '\\')
            out << '\\' << juce::String::charToString (c);
        else if (c == '\n')
            out << "\\n";
        else if (c < 0x20)
            out << "\\u" << juce::String::toHexString ((int) c).paddedLeft ('0', 4);
        else
            out << juce::String::charToString (c);
    }
    return out + "\"";
}

int setResult (const juce::String& json)
{
    result = json.toStdString();
    return (int) result.size();
}
} // namespace

MICFX_EXPORT const char* micfx_result() { return result.c_str(); }

// The Auto Mix styles, in the order "style" indices count them: ["Pop", ...].
MICFX_EXPORT int micfx_styles()
{
    juce::StringArray names;
    for (auto style : analysis::allStyles)
        names.add (quoted (analysis::getStyleName (style)));
    return setResult ("[" + names.joinIntoString (",") + "]");
}

// Sound check: the Live values for a voice (`frames` mono samples after the input gain).
// fit = 0: a new chain in a style (an index into micfx_styles). fit = 1: the chain stays
// and only its levels are fitted, from what it has now (the other arguments).
// Returns { error, values: [[id, value]...], changes: [{ module, text }], notes, advice,
// peak, lufs, noise, sung, noiseBins }; the noise profile is at micfx_noise_profile.
MICFX_EXPORT int micfx_sound_check (const float* samples, int frames, double sampleRate, int style, int fit,
                                    float inputGainDb, float minInputDb, float maxInputDb,
                                    int gate, int classicDeEsser, int denoise, float lowCutHz)
{
    SoundCheck::Plan plan;
    if (fit != 0)
    {
        analysis::fit::Chain chain;
        chain.inputGainDb = inputGainDb;
        chain.minInputDb = minInputDb;
        chain.maxInputDb = maxInputDb;
        chain.gate = gate != 0;
        chain.classicDeEsser = classicDeEsser != 0;
        chain.denoise = denoise != 0;
        plan = SoundCheck::makeFitPlan (samples, frames, sampleRate, chain, lowCutHz);
    }
    else
    {
        const auto count = (int) std::size (analysis::allStyles);
        plan = SoundCheck::makePlan (samples, frames, sampleRate, analysis::allStyles[juce::jlimit (0, count - 1, style)]);
    }

    noiseProfile = plan.noiseProfile;

    juce::StringArray values, changes, notes;
    for (const auto& [id, value] : plan.values)
        values.add ("[" + quoted (id) + "," + fixed (value, 4) + "]");
    for (const auto& change : plan.changes)
        changes.add ("{\"module\":" + quoted (change.module) + ",\"text\":" + quoted (change.text) + "}");
    for (const auto& note : plan.notes)
        notes.add (quoted (note));

    return setResult ("{\"error\":" + quoted (plan.error)
                      + ",\"values\":[" + values.joinIntoString (",") + "]"
                      + ",\"changes\":[" + changes.joinIntoString (",") + "]"
                      + ",\"notes\":[" + notes.joinIntoString (",") + "]"
                      + ",\"advice\":" + quoted (plan.inputAdvice)
                      + ",\"peak\":" + fixed (plan.peakDb, 1)
                      + ",\"lufs\":" + fixed (plan.voiceLufs, 1)
                      + ",\"noise\":" + fixed (plan.noiseDb, 1)
                      + ",\"sung\":" + fixed (plan.voiceSeconds, 1)
                      + ",\"noiseBins\":" + juce::String ((int) noiseProfile.size()) + "}");
}

// The last sound check's room profile for the denoiser (power per bin), micfx_sound_check's noiseBins long.
MICFX_EXPORT const float* micfx_noise_profile() { return noiseProfile.data(); }

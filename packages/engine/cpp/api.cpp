// The engine's C API, exported from engine.wasm.
//
// Strings in: the caller writes ASCII into micfx_text and passes its length.
// Strings out: a call returns a length, and the text is at micfx_result (valid until the next call).
// Audio crosses through the engine's own buffers (micfx_input / micfx_output).
#include "LiveEngine.h"
#include "WebParameters.h"
#include "analysis/Key.h"

#include <string>

#define MICFX_EXPORT extern "C" __attribute__ ((used, visibility ("default")))

namespace
{
constexpr int textSize = 32768;
char text[textSize];
std::string result;

struct Instance
{
    Instance (double rate, int block) : engine (rate, block), input ((size_t) block), left ((size_t) block), right ((size_t) block)
    {
        pushAll(); // the desktop's parameter defaults are the engine's starting values
    }

    // Sets a value on the engine and keeps the parameter (when there is one) in step.
    bool set (const juce::String& id, float value)
    {
        auto* parameter = parameters.find (id);
        if (parameter != nullptr)
        {
            parameter->setValue (parameter->convertTo0to1 (value));
            value = parameter->getReal();
        }
        return engine.setValue (id, value) || parameter != nullptr;
    }

    // Every parameter's value to the engine, as the desktop's processor does each block.
    void pushAll()
    {
        for (const auto& parameter : parameters.all())
            engine.setValue (parameter->getParameterID(), parameter->getReal());
    }

    // Every parameter back to its default, except the input gain (it belongs to the mic).
    void resetToDefaults()
    {
        for (const auto& parameter : parameters.all())
            if (parameter->getParameterID() != "inputGain")
                parameter->setValue (parameter->getDefaultValue());
        engine.resetValues(); // values without a parameter
        pushAll();
    }

    // The desktop's PluginProcessor::setCurrentProgram.
    bool loadPreset (int index)
    {
        const auto& presets = getPresets();
        if (! juce::isPositiveAndBelow (index, (int) presets.size()))
            return false;
        applyPreset (parameters, presets[(size_t) index]);
        engine.resetValues();
        pushAll();
        juce::StringArray order;
        for (const auto* key : presets[(size_t) index].order)
            order.add (key);
        engine.setOrder (order);
        return true;
    }

    // The tuner and the effect cards' live readings: the Live part of the desktop editor's
    // "meters" event (PluginEditor::timerCallback).
    juce::var describeStatus()
    {
        auto* status = new juce::DynamicObject();
        auto& chain = engine.getChain();
        if (auto* pitch = chain.find<fx::modules::Pitch>())
        {
            const auto& tuner = pitch->getEngine();
            status->setProperty ("note", tuner.detectedNote.load());
            status->setProperty ("target", tuner.tunedNote.load());
            juce::Array<juce::var> voices;
            for (const auto& note : tuner.voiceNotes)
                voices.add (note.load());
            status->setProperty ("voices", voices);
        }
        auto* effects = new juce::DynamicObject();
        for (int i = 0; i < chain.size(); ++i)
            if (auto meter = fx::describeMeter (chain[i], spectrumAnalyser); ! meter.isVoid())
                effects->setProperty (fx::getModuleKey (chain[i].getType()), meter);
        status->setProperty ("fx", juce::var (effects));
        return juce::var (status);
    }

    micfx::web::WebParameters parameters;
    micfx::web::LiveEngine engine;
    fx::SpectrumAnalyser spectrumAnalyser;
    std::vector<float> input, left, right;
    float meters[3] {};
    juce::AudioBuffer<float> exported; // a looper layer, for saving
};

juce::String readText (int length)
{
    return juce::String (text, (size_t) juce::jlimit (0, textSize - 1, length));
}

int writeResult (const juce::String& value)
{
    result = value.toStdString();
    return (int) result.size();
}
} // namespace

MICFX_EXPORT char* micfx_text()          { return text; }
MICFX_EXPORT const char* micfx_result()  { return result.c_str(); }

MICFX_EXPORT Instance* micfx_create (double sampleRate, int maxBlockSize)
{
    return new Instance (sampleRate, juce::jlimit (16, 8192, maxBlockSize));
}

MICFX_EXPORT void micfx_destroy (Instance* instance) { delete instance; }

MICFX_EXPORT float* micfx_input (Instance* instance)              { return instance->input.data(); }
MICFX_EXPORT float* micfx_output (Instance* instance, int channel) { return channel == 0 ? instance->left.data() : instance->right.data(); }

MICFX_EXPORT void micfx_process (Instance* instance, int numSamples)
{
    numSamples = juce::jlimit (0, (int) instance->input.size(), numSamples);
    instance->engine.process (instance->input.data(), instance->left.data(), instance->right.data(), numSamples);
}

// The ID is in micfx_text, `idLength` bytes. 1 when the ID is known.
MICFX_EXPORT int micfx_set_value (Instance* instance, int idLength, float value)
{
    return instance->set (readText (idLength), value) ? 1 : 0;
}

// NaN for an unknown ID.
MICFX_EXPORT float micfx_get_value (Instance* instance, int idLength)
{
    const auto id = readText (idLength);
    if (auto* parameter = instance->parameters.find (id))
        return parameter->getReal();
    float value = 0;
    return instance->engine.getValue (id, value) ? value : std::numeric_limits<float>::quiet_NaN();
}

MICFX_EXPORT void micfx_reset_values (Instance* instance) { instance->resetToDefaults(); }

// Every engine value as "id=default=switch=moduleKey" lines.
MICFX_EXPORT int micfx_value_info (Instance* instance)
{
    juce::String lines;
    for (const auto& info : instance->engine.getValueInfo())
        lines << info.id << "=" << juce::String (info.defaultValue) << "=" << (info.isSwitch ? "1" : "0") << "=" << info.module << "\n";
    return writeResult (lines);
}

// The desktop parameters as JSON: { id: { name, min, max, skew, step, label, default, choices?, bool? } }.
MICFX_EXPORT int micfx_parameter_info (Instance* instance)
{
    return writeResult (juce::JSON::toString (instance->parameters.describe(), juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none)));
}

// The factory presets as JSON: [{ name, category, values, order }].
MICFX_EXPORT int micfx_presets()
{
    return writeResult (juce::JSON::toString (micfx::web::WebParameters::describePresets(), juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none)));
}

// Loads a factory preset by index, as the desktop does. 1 when it exists.
MICFX_EXPORT int micfx_load_preset (Instance* instance, int index)
{
    return instance->loadPreset (index) ? 1 : 0;
}

// The order as comma-separated module keys in micfx_text.
MICFX_EXPORT void micfx_set_order (Instance* instance, int length)
{
    instance->engine.setOrder (juce::StringArray::fromTokens (readText (length), ",", ""));
}

MICFX_EXPORT int micfx_get_order (Instance* instance)
{
    return writeResult (instance->engine.getOrder().joinIntoString (","));
}

// The tuner and effect readings as JSON: { note, target, voices, fx: { key: reading } }.
MICFX_EXPORT int micfx_status (Instance* instance)
{
    return writeResult (juce::JSON::toString (instance->describeStatus(), juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none)));
}

// [input peak, output peak, latency in samples], peaks since the last call.
MICFX_EXPORT float* micfx_meters (Instance* instance)
{
    const auto peaks = instance->engine.takeMeters();
    instance->meters[0] = peaks.input;
    instance->meters[1] = peaks.output;
    instance->meters[2] = (float) instance->engine.getLatencySamples();
    return instance->meters;
}

// The key of a song (the desktop's analysis::detectKey), from `frames` mono samples at
// `samples` (the caller's malloc). JSON: { ok, key, minor, name, confidencePerMille }.
MICFX_EXPORT int micfx_detect_key (float* samples, int frames, double sampleRate)
{
    float* channels[] = { samples };
    const juce::AudioBuffer<float> audio (channels, 1, frames);
    const auto key = analysis::detectKey (audio, sampleRate);

    // Written by hand: JUCE's double-to-text goes through std::ostream, which the standalone
    // build has no locale for.
    const auto name = key.isValid() ? key.getName() : juce::String();
    return writeResult ("{\"ok\":" + juce::String (key.isValid() ? "true" : "false")
                        + ",\"key\":" + juce::String (key.key)
                        + ",\"minor\":" + juce::String (key.minor ? "true" : "false")
                        + ",\"name\":" + juce::JSON::toString (name)
                        + ",\"confidencePerMille\":" + juce::String (juce::roundToInt (key.confidence * 1000.0f)) + "}");
}

//==============================================================================
// The looper (the desktop's "looper" native function, src/PluginEditor.cpp).

namespace
{
// A number for JSON with `decimals` places, without std::ostream (see micfx_detect_key).
juce::String fixed (double value, int decimals = 3)
{
    const auto scale = std::pow (10.0, decimals);
    auto scaled = (juce::int64) std::llround (std::abs (value) * scale);
    const auto whole = scaled / (juce::int64) scale;
    auto fraction = juce::String (scaled % (juce::int64) scale).paddedLeft ('0', decimals);
    return (value < 0 && scaled != 0 ? "-" : "") + juce::String (whole) + (decimals > 0 ? "." + fraction : juce::String());
}
}

// 0 main (record / overdub / end the overdub / play), 1 stop, 2 play, 3 undo, 4 redo, 5 clear.
MICFX_EXPORT int micfx_looper_command (Instance* instance, int command)
{
    if (command < 0 || command > 5)
        return 0;
    return instance->engine.getLooper().send ((Looper::Command) command) ? 1 : 0;
}

// A layer's gain and mute; a negative value leaves it as it is.
MICFX_EXPORT void micfx_looper_layer (Instance* instance, int layer, float gain, int muted)
{
    auto& looper = instance->engine.getLooper();
    if (gain >= 0.0f) looper.setLayerGain (layer, gain);
    if (muted >= 0)   looper.setLayerMuted (layer, muted != 0);
}

// Tempo and volume; a negative value leaves it as it is.
MICFX_EXPORT void micfx_looper_settings (Instance* instance, double bpm, int beatsPerBar, int locked, float volume)
{
    auto& looper = instance->engine.getLooper();
    looper.setTempo (bpm > 0 ? bpm : looper.getBpm(), beatsPerBar > 0 ? beatsPerBar : looper.getBeatsPerBar());
    if (locked >= 0)     looper.setTempoLocked (locked != 0);
    if (volume >= 0.0f)  looper.setVolume (juce::jlimit (0.0f, 2.0f, volume));
}

// The desktop's describeLooper as JSON, with the layers' 96-bin overviews when asked.
MICFX_EXPORT int micfx_looper_state (Instance* instance, int withOverview)
{
    const auto& looper = instance->engine.getLooper();
    const auto rate = looper.getSampleRate();
    const auto layers = looper.getNumLayers();

    juce::String json;
    json << "{\"state\":\"" << Looper::getStateName (looper.getState()) << "\""
         << ",\"layers\":" << layers
         << ",\"redo\":" << looper.getNumRedoLayers()
         << ",\"maxLayers\":" << Looper::maxLayers
         << ",\"length\":" << fixed ((double) looper.getLength() / rate)
         << ",\"position\":" << fixed ((double) looper.getPosition() / rate)
         << ",\"closing\":" << fixed ((double) looper.getClosingTarget() / rate)
         << ",\"maxSeconds\":" << fixed (Looper::maxSeconds, 0)
         << ",\"bpm\":" << fixed (looper.getBpm(), 2)
         << ",\"beatsPerBar\":" << looper.getBeatsPerBar()
         << ",\"locked\":" << (looper.isTempoLocked() ? "true" : "false")
         << ",\"volume\":" << fixed (looper.getVolume());

    juce::StringArray gains, mutes;
    for (int i = 0; i < Looper::maxLayers; ++i)
    {
        gains.add (fixed (looper.getLayerGain (i)));
        mutes.add (looper.isLayerMuted (i) ? "true" : "false");
    }
    json << ",\"gains\":[" << gains.joinIntoString (",") << "],\"mutes\":[" << mutes.joinIntoString (",") << "]";

    if (withOverview != 0)
    {
        juce::StringArray overviews;
        for (int i = 0; i < layers; ++i)
        {
            juce::StringArray peaks;
            for (auto peak : looper.getOverview (i, 96))
                peaks.add (fixed (peak));
            overviews.add ("[" + peaks.joinIntoString (",") + "]");
        }
        json << ",\"overviews\":[" << overviews.joinIntoString (",") << "]";
    }
    return writeResult (json + "}");
}

// Copies one pass of a looper layer; returns its length in frames (0: no such layer).
// The audio is then at micfx_looper_copied (channel 0 and 1) until the next copy.
MICFX_EXPORT int micfx_looper_copy (Instance* instance, int layer)
{
    if (! instance->engine.getLooper().copyLayer (layer, instance->exported))
        return 0;
    return instance->exported.getNumSamples();
}

MICFX_EXPORT const float* micfx_looper_copied (Instance* instance, int channel)
{
    return instance->exported.getReadPointer (juce::jlimit (0, juce::jmax (0, instance->exported.getNumChannels() - 1), channel));
}

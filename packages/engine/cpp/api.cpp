// The engine's C API, exported from engine.wasm.
//
// Strings in: the caller writes ASCII into micfx_text and passes its length.
// Strings out: a call returns a length, and the text is at micfx_result (valid until the next call).
// Audio crosses through the engine's own buffers (micfx_input / micfx_output).
#include "LiveEngine.h"
#include "WebParameters.h"

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

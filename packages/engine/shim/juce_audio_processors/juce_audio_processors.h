#pragma once

// A tiny stand-in for JUCE's juce_audio_processors, for the web build only.
//
// The real module needs juce_events and juce_gui_*, which don't build for WebAssembly. The
// desktop's Parameters.cpp and Presets.cpp use only a small part of it (the parameter
// classes, the layout, AudioProcessor::getParameters), so this provides that part with the
// same names and behaviour. It lets the web engine compile those two files unchanged, so
// the parameter list, ranges, defaults and factory presets come straight from the desktop.
// If the desktop starts using more of the API there, the web build fails to compile, and
// this file grows to match.

#include <juce_audio_basics/juce_audio_basics.h>

#include <memory>
#include <vector>

namespace juce
{
class ParameterID
{
public:
    ParameterID() = default;
    ParameterID (const String& identifier, int version = 0) : id (identifier), versionHint (version) {}
    ParameterID (const char* identifier, int version = 0) : id (identifier), versionHint (version) {}
    const String& getParamID() const noexcept { return id; }
    int getVersionHint() const noexcept       { return versionHint; }

private:
    String id;
    int versionHint = 0;
};

class AudioParameterFloatAttributes
{
public:
    AudioParameterFloatAttributes withLabel (const String& newLabel) const
    {
        auto copy = *this;
        copy.label = newLabel;
        return copy;
    }
    String label;
};

class AudioProcessorParameter
{
public:
    virtual ~AudioProcessorParameter() = default;
    virtual float getValue() const = 0;
    virtual void setValue (float newValue) = 0;
    virtual float getDefaultValue() const = 0;
    void setValueNotifyingHost (float newValue) { setValue (newValue); }
    void beginChangeGesture() {}
    void endChangeGesture() {}
};

class RangedAudioParameter : public AudioProcessorParameter
{
public:
    RangedAudioParameter (const ParameterID& parameterId, const String& parameterName, NormalisableRange<float> r,
                          float defaultReal, const String& parameterLabel)
        : id (parameterId.getParamID()), name (parameterName), label (parameterLabel), range (r),
          defaultValue (range.convertTo0to1 (range.snapToLegalValue (defaultReal))), value (defaultValue) {}

    const String& getParameterID() const noexcept                   { return id; }
    String getName (int maxLength = 1024) const                       { return name.substring (0, maxLength); }
    String getLabel() const                                           { return label; }
    const NormalisableRange<float>& getNormalisableRange() const      { return range; }

    float getValue() const override        { return value; }
    void setValue (float v) override       { value = jlimit (0.0f, 1.0f, v); }
    float getDefaultValue() const override { return defaultValue; }

    float convertTo0to1 (float v) const noexcept   { return range.convertTo0to1 (range.snapToLegalValue (v)); }
    float convertFrom0to1 (float v) const noexcept { return range.snapToLegalValue (range.convertFrom0to1 (jlimit (0.0f, 1.0f, v))); }

    /** The value in real units. */
    float getReal() const noexcept { return convertFrom0to1 (value); }

private:
    String id, name, label;
    NormalisableRange<float> range;
    float defaultValue, value;
};

class AudioParameterFloat : public RangedAudioParameter
{
public:
    AudioParameterFloat (const ParameterID& parameterId, const String& parameterName, NormalisableRange<float> r,
                         float defaultReal, const AudioParameterFloatAttributes& attributes = {})
        : RangedAudioParameter (parameterId, parameterName, r, defaultReal, attributes.label) {}

    float get() const noexcept { return getReal(); }
    operator float() const noexcept { return get(); }
};

class AudioParameterBool : public RangedAudioParameter
{
public:
    AudioParameterBool (const ParameterID& parameterId, const String& parameterName, bool defaultOn)
        : RangedAudioParameter (parameterId, parameterName, { 0.0f, 1.0f, 1.0f }, defaultOn ? 1.0f : 0.0f, {}) {}

    bool get() const noexcept { return getValue() >= 0.5f; }
    operator bool() const noexcept { return get(); }
};

class AudioParameterChoice : public RangedAudioParameter
{
public:
    AudioParameterChoice (const ParameterID& parameterId, const String& parameterName, const StringArray& c, int defaultIndex)
        : RangedAudioParameter (parameterId, parameterName, { 0.0f, (float) jmax (0, c.size() - 1), 1.0f }, (float) defaultIndex, {}),
          choices (c) {}

    int getIndex() const noexcept { return roundToInt (getReal()); }
    operator int() const noexcept { return getIndex(); }

    const StringArray choices;
};

class AudioProcessorValueTreeState
{
public:
    class ParameterLayout
    {
    public:
        template <typename Param>
        void add (std::unique_ptr<Param> parameter) { parameters.push_back (std::move (parameter)); }

        std::vector<std::unique_ptr<RangedAudioParameter>> parameters;
    };
};

class AudioProcessor
{
public:
    virtual ~AudioProcessor() = default;
    const Array<AudioProcessorParameter*>& getParameters() const noexcept { return parameterList; }

protected:
    Array<AudioProcessorParameter*> parameterList;
};
} // namespace juce

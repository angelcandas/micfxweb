#pragma once

// A stand-in for JUCE's juce_audio_processors, for the web build only.
//
// The real module needs juce_gui_*, which doesn't build for WebAssembly. The desktop code
// the web compiles uses a part of it: the parameter classes and layout (Parameters.cpp,
// Presets.cpp), and, in the studio build (with juce_events and juce_data_structures), the
// AudioProcessor interface the DAW engine and the MicFX instruments use, the
// AudioProcessorValueTreeState, and the names plug-in hosting needs (no plug-in is ever
// loaded on the web). This provides that part with the same names and behaviour. If the
// desktop starts using more of the API, the web build fails to compile, and this file grows
// to match.

#include <juce_audio_basics/juce_audio_basics.h>
#if JUCE_MODULE_AVAILABLE_juce_data_structures
 #include <juce_events/juce_events.h>
 #include <juce_data_structures/juce_data_structures.h>
#endif

#include <atomic>
#include <functional>
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
    void setValue (float v) override       { value = jlimit (0.0f, 1.0f, v); if (onSet) onSet(); }
    float getDefaultValue() const override { return defaultValue; }

    float convertTo0to1 (float v) const noexcept   { return range.convertTo0to1 (range.snapToLegalValue (v)); }
    float convertFrom0to1 (float v) const noexcept { return range.snapToLegalValue (range.convertFrom0to1 (jlimit (0.0f, 1.0f, v))); }

    /** The value in real units. */
    float getReal() const noexcept { return convertFrom0to1 (value); }

    /** Called after each set (the value tree state's raw values follow it). */
    std::function<void()> onSet;

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

#if ! JUCE_MODULE_AVAILABLE_juce_data_structures
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
#else
//==============================================================================
// The studio build: enough of the real thing for the DAW engine and the instruments.

/** Colours are only for windows, which the web draws itself; kept so the specs compile. */
class Colour
{
public:
    Colour() = default;
    constexpr explicit Colour (uint32 argb) noexcept : value (argb) {}
    static Colour fromRGB (uint8 r, uint8 g, uint8 b) noexcept { return Colour (0xff000000u | ((uint32) r << 16) | ((uint32) g << 8) | b); }
    uint32 getARGB() const noexcept { return value; }
    String toDisplayString (bool includeAlpha) const { return String::toHexString ((int) (includeAlpha ? value : (value & 0xffffffu))).paddedLeft ('0', includeAlpha ? 8 : 6).toUpperCase(); }

private:
    uint32 value = 0;
};

class AudioProcessor;

/** Never made on the web: the page draws the instruments' windows. */
class AudioProcessorEditor
{
public:
    explicit AudioProcessorEditor (AudioProcessor&) {}
    virtual ~AudioProcessorEditor() = default;
};

class AudioProcessor
{
public:
    struct BusProperties
    {
        String busName;
        AudioChannelSet defaultLayout;
        bool isActivatedByDefault = true;
    };

    struct BusesProperties
    {
        BusesProperties withInput (const String& name, const AudioChannelSet& layout, bool active = true) const
        {
            auto copy = *this;
            copy.inputLayouts.add ({ name, layout, active });
            return copy;
        }

        BusesProperties withOutput (const String& name, const AudioChannelSet& layout, bool active = true) const
        {
            auto copy = *this;
            copy.outputLayouts.add ({ name, layout, active });
            return copy;
        }

        Array<BusProperties> inputLayouts, outputLayouts;
    };

    struct BusesLayout
    {
        Array<AudioChannelSet> inputBuses, outputBuses;

        AudioChannelSet getMainInputChannelSet() const  { return inputBuses.isEmpty() ? AudioChannelSet() : inputBuses.getReference (0); }
        AudioChannelSet getMainOutputChannelSet() const { return outputBuses.isEmpty() ? AudioChannelSet() : outputBuses.getReference (0); }
        int getMainInputChannels() const noexcept        { return getMainInputChannelSet().size(); }
        int getMainOutputChannels() const noexcept       { return getMainOutputChannelSet().size(); }

        bool operator== (const BusesLayout& other) const noexcept { return inputBuses == other.inputBuses && outputBuses == other.outputBuses; }
        bool operator!= (const BusesLayout& other) const noexcept { return ! operator== (other); }
    };

    AudioProcessor() : AudioProcessor (BusesProperties().withInput ("Input", AudioChannelSet::stereo()).withOutput ("Output", AudioChannelSet::stereo())) {}

    explicit AudioProcessor (const BusesProperties& properties)
    {
        for (const auto& bus : properties.inputLayouts)
            if (bus.isActivatedByDefault)
                layout.inputBuses.add (bus.defaultLayout);
        for (const auto& bus : properties.outputLayouts)
            if (bus.isActivatedByDefault)
                layout.outputBuses.add (bus.defaultLayout);
    }

    virtual ~AudioProcessor() = default;

    //==============================================================================
    virtual const String getName() const = 0;
    virtual void prepareToPlay (double sampleRate, int maximumExpectedSamplesPerBlock) = 0;
    virtual void releaseResources() = 0;
    virtual void processBlock (AudioBuffer<float>&, MidiBuffer&) = 0;
    virtual void processBlock (AudioBuffer<double>&, MidiBuffer&) {}
    virtual void reset() {}
    virtual bool isBusesLayoutSupported (const BusesLayout&) const { return true; }

    virtual double getTailLengthSeconds() const = 0;
    virtual bool acceptsMidi() const = 0;
    virtual bool producesMidi() const = 0;
    virtual bool isMidiEffect() const { return false; }

    virtual AudioProcessorEditor* createEditor() = 0;
    virtual bool hasEditor() const = 0;

    virtual int getNumPrograms() = 0;
    virtual int getCurrentProgram() = 0;
    virtual void setCurrentProgram (int index) = 0;
    virtual const String getProgramName (int index) = 0;
    virtual void changeProgramName (int index, const String& newName) = 0;

    virtual void getStateInformation (MemoryBlock& destData) = 0;
    virtual void setStateInformation (const void* data, int sizeInBytes) = 0;

    //==============================================================================
    double getSampleRate() const noexcept { return currentSampleRate; }
    int getBlockSize() const noexcept     { return blockSize; }
    void setRateAndBufferSizeDetails (double newSampleRate, int newBlockSize) noexcept
    {
        currentSampleRate = newSampleRate;
        blockSize = newBlockSize;
    }

    int getLatencySamples() const noexcept     { return latencySamples; }
    void setLatencySamples (int newLatency)    { latencySamples = newLatency; }

    const CriticalSection& getCallbackLock() const noexcept { return callbackLock; }
    void suspendProcessing (bool shouldBeSuspended)          { const ScopedLock sl (callbackLock); suspended = shouldBeSuspended; }
    bool isSuspended() const noexcept                         { return suspended; }

    bool isNonRealtime() const noexcept            { return nonRealtime; }
    virtual void setNonRealtime (bool isNonRealtime) noexcept { nonRealtime = isNonRealtime; }

    AudioPlayHead* getPlayHead() const noexcept    { return playHead; }
    virtual void setPlayHead (AudioPlayHead* newPlayHead) { playHead = newPlayHead; }

    //==============================================================================
    BusesLayout getBusesLayout() const { return layout; }
    bool checkBusesLayoutSupported (const BusesLayout& candidate) const { return isBusesLayoutSupported (candidate); }
    bool setBusesLayout (const BusesLayout& candidate)
    {
        if (! isBusesLayoutSupported (candidate))
            return false;
        layout = candidate;
        return true;
    }

    int getTotalNumInputChannels() const noexcept  { return total (layout.inputBuses); }
    int getTotalNumOutputChannels() const noexcept { return total (layout.outputBuses); }
    int getMainBusNumInputChannels() const noexcept  { return layout.getMainInputChannels(); }
    int getMainBusNumOutputChannels() const noexcept { return layout.getMainOutputChannels(); }

    //==============================================================================
    void addParameter (AudioProcessorParameter* parameter)
    {
        ownedParameters.emplace_back (parameter);
        parameterList.add (parameter);
    }

    const Array<AudioProcessorParameter*>& getParameters() const noexcept { return parameterList; }

    AudioProcessorEditor* getActiveEditor() const noexcept { return nullptr; }
    void updateHostDisplay() {}

    static void copyXmlToBinary (const XmlElement& xml, MemoryBlock& destData)
    {
        const auto text = xml.toString (XmlElement::TextFormat().singleLine().withoutHeader());
        destData.reset();
        destData.append (text.toRawUTF8(), text.getNumBytesAsUTF8());
    }

    static std::unique_ptr<XmlElement> getXmlFromBinary (const void* data, int sizeInBytes)
    {
        if (data == nullptr || sizeInBytes <= 0)
            return {};
        return parseXML (String::fromUTF8 (static_cast<const char*> (data), sizeInBytes));
    }

protected:
    Array<AudioProcessorParameter*> parameterList;

private:
    static int total (const Array<AudioChannelSet>& buses)
    {
        int count = 0;
        for (const auto& bus : buses)
            count += bus.size();
        return count;
    }

    BusesLayout layout;
    std::vector<std::unique_ptr<AudioProcessorParameter>> ownedParameters;
    CriticalSection callbackLock;
    double currentSampleRate = 0.0;
    int blockSize = 0, latencySamples = 0;
    bool suspended = false, nonRealtime = false;
    AudioPlayHead* playHead = nullptr;
};

//==============================================================================
class AudioProcessorValueTreeState
{
public:
    class ParameterLayout
    {
    public:
        ParameterLayout() = default;
        ParameterLayout (ParameterLayout&&) = default;
        ParameterLayout& operator= (ParameterLayout&&) = default;

        template <typename Param>
        void add (std::unique_ptr<Param> parameter) { parameters.push_back (std::move (parameter)); }

        std::vector<std::unique_ptr<RangedAudioParameter>> parameters;
    };

    class Listener
    {
    public:
        virtual ~Listener() = default;
        virtual void parameterChanged (const String& parameterID, float newValue) = 0;
    };

    AudioProcessorValueTreeState (AudioProcessor& p, UndoManager* undo, const Identifier& valueTreeType, ParameterLayout parameterLayout)
        : processor (p), undoManager (undo), state (valueTreeType)
    {
        for (auto& parameter : parameterLayout.parameters)
        {
            auto* raw = parameter.release();
            values.emplace_back (std::make_unique<Entry> (raw));
            p.addParameter (raw);
        }
    }

    RangedAudioParameter* getParameter (StringRef parameterID) const noexcept
    {
        auto* entry = find (parameterID);
        return entry != nullptr ? entry->parameter : nullptr;
    }

    /** The parameter's value in real units, kept up to date as it is set (read it from any thread). */
    std::atomic<float>* getRawParameterValue (StringRef parameterID) const noexcept
    {
        auto* entry = find (parameterID);
        if (entry == nullptr)
            return nullptr;
        entry->real.store (entry->parameter->getReal());
        entry->parameter->onSet = [entry] { entry->real.store (entry->parameter->getReal()); };
        return &entry->real;
    }

    void addParameterListener (StringRef, Listener*) {}
    void removeParameterListener (StringRef, Listener*) {}

    /** The state with every parameter's value, as JUCE writes it (PARAM id/value children). */
    ValueTree copyState()
    {
        for (const auto& entry : values)
        {
            auto param = state.getChildWithProperty ("id", entry->parameter->getParameterID());
            if (! param.isValid())
            {
                param = ValueTree ("PARAM");
                param.setProperty ("id", entry->parameter->getParameterID(), nullptr);
                state.appendChild (param, nullptr);
            }
            param.setProperty ("value", entry->parameter->getReal(), nullptr);
        }
        return state.createCopy();
    }

    void replaceState (const ValueTree& newState)
    {
        state = newState.createCopy();
        for (const auto& entry : values)
        {
            const auto param = state.getChildWithProperty ("id", entry->parameter->getParameterID());
            const auto real = param.isValid() ? (float) param.getProperty ("value", entry->parameter->getReal())
                                              : entry->parameter->convertFrom0to1 (entry->parameter->getDefaultValue());
            entry->parameter->setValueNotifyingHost (entry->parameter->convertTo0to1 (real));
        }
    }

    AudioProcessor& processor;
    UndoManager* const undoManager;
    ValueTree state;

private:
    struct Entry
    {
        explicit Entry (RangedAudioParameter* p) : parameter (p), real (p->getReal()) {}
        RangedAudioParameter* parameter;
        mutable std::atomic<float> real;
    };

    Entry* find (StringRef parameterID) const noexcept
    {
        for (const auto& entry : values)
            if (entry->parameter->getParameterID() == parameterID)
                return entry.get();
        return nullptr;
    }

    std::vector<std::unique_ptr<Entry>> values;
};

//==============================================================================
// Plug-in hosting: the names only. The web has no VST3 or AU plug-ins.
class PluginDescription
{
public:
    String name, descriptiveName, pluginFormatName, category, manufacturerName, version, fileOrIdentifier;
    int uniqueId = 0, deprecatedUid = 0, numInputChannels = 0, numOutputChannels = 0;
    bool isInstrument = false, hasSharedContainer = false, hasARAExtension = false;
    Time lastFileModTime, lastInfoUpdateTime;

    String createIdentifierString() const { return pluginFormatName + "-" + name + "-" + String::toHexString (uniqueId); }
    std::unique_ptr<XmlElement> createXml() const { return std::make_unique<XmlElement> ("PLUGIN"); }
    bool loadFromXml (const XmlElement&) { return false; }
};

class AudioPluginInstance : public AudioProcessor
{
public:
    using AudioProcessor::AudioProcessor;
    virtual void fillInPluginDescription (PluginDescription&) const = 0;
    PluginDescription getPluginDescription() const
    {
        PluginDescription description;
        fillInPluginDescription (description);
        return description;
    }
};
#endif
} // namespace juce

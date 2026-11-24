#include "LiveEngine.h"

namespace micfx::web
{
LiveEngine::LiveEngine (double sampleRate, int maxBlockSize)
{
    const juce::dsp::ProcessSpec spec { sampleRate, (juce::uint32) maxBlockSize, 2 };

    inputGain.prepare (spec);
    outputGain.prepare (spec);
    limiter.prepare (spec);
    inputGain.setRampDurationSeconds (0.05);
    outputGain.setRampDurationSeconds (0.05);
    limiter.setThreshold (-1.0f);
    limiter.setRelease (100.0f);

    buffer.setSize (2, maxBlockSize);

    for (int m = 0; m < chain.size(); ++m)
    {
        auto& module = chain[m];
        for (int v = 0; v < module.getNumValues(); ++v)
            valueInfo.push_back ({ module.getValueId (v), module.getValue (v).load(), module.isSwitch (v) });
    }
    valueInfo.push_back ({ "inputGain", 0.0f, false });
    valueInfo.push_back ({ "outputGain", 0.0f, false });

    chain.prepare (spec);
    inputGain.reset();
    outputGain.reset();
    limiter.reset();
}

void LiveEngine::process (const float* input, float* left, float* right, int numSamples) noexcept
{
    juce::ScopedNoDenormals noDenormals;
    numSamples = juce::jlimit (0, buffer.getNumSamples(), numSamples);

    // A mono mic feeds both sides, so the stereo effects have signal on each.
    buffer.copyFrom (0, 0, input, numSamples);
    buffer.copyFrom (1, 0, input, numSamples);

    auto block = juce::dsp::AudioBlock<float> (buffer).getSubBlock (0, (size_t) numSamples);
    const fx::Context context (block);

    inputGain.setGainDecibels (inputGainDb);
    outputGain.setGainDecibels (outputGainDb);

    inputGain.process (context);
    peaks.input = juce::jmax (peaks.input, buffer.getMagnitude (0, 0, numSamples));

    if (! dry)
        chain.process (context);

    outputGain.process (context);
    limiter.process (context);

    if (muted)
        buffer.clear (0, numSamples);

    peaks.output = juce::jmax (peaks.output, buffer.getMagnitude (0, numSamples));

    std::copy_n (buffer.getReadPointer (0), numSamples, left);
    std::copy_n (buffer.getReadPointer (1), numSamples, right);
}

bool LiveEngine::setValue (const juce::String& id, float value) noexcept
{
    if (! std::isfinite (value))
        return false;
    if (id == "inputGain")   { inputGainDb = juce::jlimit (-24.0f, 24.0f, value); return true; }
    if (id == "outputGain")  { outputGainDb = juce::jlimit (-24.0f, 24.0f, value); return true; }
    if (id == "dryCompare")  { dry = value >= 0.5f; return true; }
    if (id == "outputMuted") { muted = value >= 0.5f; return true; }
    return chain.setValue (id, value);
}

bool LiveEngine::getValue (const juce::String& id, float& value) const noexcept
{
    if (id == "inputGain")  { value = inputGainDb; return true; }
    if (id == "outputGain") { value = outputGainDb; return true; }

    auto& modules = const_cast<fx::FxChain&> (chain);
    for (int m = 0; m < modules.size(); ++m)
        if (auto* found = modules[m].findValue (id))
        {
            value = found->load();
            return true;
        }
    return false;
}

void LiveEngine::resetValues() noexcept
{
    for (const auto& info : valueInfo)
        if (info.id != "inputGain") // the input gain belongs to the mic, not to a preset
            setValue (info.id, info.defaultValue);
}

// The same placement as PluginProcessor::setChainOrder in the desktop app.
void LiveEngine::setOrder (const juce::StringArray& keys)
{
    std::vector<int> order;
    std::vector<bool> placed ((size_t) chain.size(), false);

    for (const auto& key : keys)
        for (int i = 0; i < chain.size(); ++i)
            if (! placed[(size_t) i] && key.trim() == fx::getModuleKey (chain[i].getType()))
            {
                order.push_back (i);
                placed[(size_t) i] = true;
            }

    // A whole saved order: an effect added since goes right after the one before it in the
    // standard order. A short list: the rest follow it in the standard order.
    const auto savedWhole = (int) order.size() >= chain.size() - 4;

    for (int i = 0; i < chain.size(); ++i)
    {
        if (placed[(size_t) i])
            continue;

        auto at = order.end();
        if (savedWhole)
            at = order.begin();
        for (int before = i - 1; before >= 0 && savedWhole; --before)
            if (const auto found = std::find (order.begin(), order.end(), before); found != order.end())
            {
                at = found + 1;
                break;
            }

        order.insert (at, i);
        placed[(size_t) i] = true;
    }

    chain.setOrder (order);
}

juce::StringArray LiveEngine::getOrder() const
{
    juce::StringArray keys;
    auto& modules = const_cast<fx::FxChain&> (chain);
    for (const auto index : modules.getOrder())
        keys.add (fx::getModuleKey (modules[index].getType()));
    return keys;
}

LiveEngine::Meters LiveEngine::takeMeters() noexcept
{
    const auto taken = peaks;
    peaks = {};
    return taken;
}
} // namespace micfx::web

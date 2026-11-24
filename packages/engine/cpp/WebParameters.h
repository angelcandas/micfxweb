#pragma once

// The desktop's parameter list and factory presets, compiled unchanged from
// extern/local-mic-effects/src (Parameters.cpp, Presets.cpp) against the small
// juce_audio_processors stand-in in shim/.
#include "Parameters.h"
#include "Presets.h"

namespace micfx::web
{
class WebParameters : public juce::AudioProcessor
{
public:
    WebParameters()
    {
        for (auto& parameter : layout.parameters)
        {
            parameterList.add (parameter.get());
            byId.set (parameter->getParameterID(), parameter.get());
        }
    }

    juce::RangedAudioParameter* find (const juce::String& id) const { return byId[id]; }

    // Every parameter, in the desktop's order.
    const std::vector<std::unique_ptr<juce::RangedAudioParameter>>& all() const { return layout.parameters; }

    // { id: { name, min, max, skew, step, label, default, choices?, bool? } }, the same shape as
    // the desktop's "getParameterInfo" native function (plus the name).
    juce::var describe() const
    {
        auto* info = new juce::DynamicObject();
        for (const auto& parameter : layout.parameters)
        {
            auto* entry = new juce::DynamicObject();
            const auto& range = parameter->getNormalisableRange();
            entry->setProperty ("name", parameter->getName());
            entry->setProperty ("min", range.start);
            entry->setProperty ("max", range.end);
            entry->setProperty ("skew", range.skew);
            entry->setProperty ("step", range.interval);
            entry->setProperty ("label", parameter->getLabel());
            entry->setProperty ("default", parameter->convertFrom0to1 (parameter->getDefaultValue()));
            if (auto* choice = dynamic_cast<juce::AudioParameterChoice*> (parameter.get()))
            {
                juce::Array<juce::var> choices;
                for (const auto& c : choice->choices)
                    choices.add (c);
                entry->setProperty ("choices", choices);
            }
            if (dynamic_cast<juce::AudioParameterBool*> (parameter.get()) != nullptr)
                entry->setProperty ("bool", true);
            info->setProperty (parameter->getParameterID(), juce::var (entry));
        }
        return juce::var (info);
    }

    // [{ name, category, values: { id: value }, order: [keys] }], the desktop's factory presets.
    static juce::var describePresets()
    {
        juce::Array<juce::var> list;
        for (const auto& preset : getPresets())
        {
            auto* entry = new juce::DynamicObject();
            entry->setProperty ("name", juce::String (preset.name));
            entry->setProperty ("category", juce::String (preset.category));
            auto* values = new juce::DynamicObject();
            for (const auto& [id, value] : preset.values)
                values->setProperty (juce::Identifier (id), value);
            entry->setProperty ("values", juce::var (values));
            juce::Array<juce::var> order;
            for (const auto* key : preset.order)
                order.add (juce::String (key));
            entry->setProperty ("order", order);
            list.add (juce::var (entry));
        }
        return list;
    }

private:
    juce::AudioProcessorValueTreeState::ParameterLayout layout;
    Parameters params { layout };
    juce::HashMap<juce::String, juce::RangedAudioParameter*> byId;
};
} // namespace micfx::web

#pragma once

// Desktop projects in and out of the browser (plan point 22). A desktop project is a folder
// "Name.micfx" (project.xml, Audio/...). On the web it can come in as that folder (picked on
// the computer and copied into storage by the page) or as one ".micfxproj" file (a zip of the
// folder), and go out the same two ways.
#include <juce_core/juce_core.h>

namespace webproject
{
static constexpr const char* bundleExtension = ".micfxproj";

// A copy of the project as the desktop opens it, in a fresh folder under /tmp: `session`
// (an XML file with the session now) as project.xml, with every audio file the session uses
// that's outside the project copied into Audio/ and pointed at there. Backups, versions and
// history stay behind. -> the staged "Name.micfx" folder, or an error.
juce::Result stage (const juce::File& projectFolder, const juce::File& session, juce::File& staged);

// The staged folder zipped as "Name.micfxproj" next to it.
juce::Result pack (const juce::File& staged, juce::File& bundle);

// A .micfxproj (or any zip holding a project.xml) unpacked into `projectsFolder` under a
// name that's free. -> the project folder.
juce::Result unpack (const juce::File& bundle, const juce::File& projectsFolder, juce::File& project);

// Every file under `folder`, as paths relative to it.
juce::StringArray listFiles (const juce::File& folder);
}

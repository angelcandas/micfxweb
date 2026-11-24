#include "WebProject.h"

namespace webproject
{
namespace
{
const juce::StringArray pathAttributes { "file", "rebalanceFrom" };
const juce::StringArray leftBehind { "Backups", "History", "Versions" };

juce::File freeChild (const juce::File& folder, const juce::String& name, const juce::String& extension)
{
    auto file = folder.getChildFile (name + extension);
    for (int n = 2; file.exists(); ++n)
        file = folder.getChildFile (name + " " + juce::String (n) + extension);
    return file;
}

void forEachElement (juce::XmlElement& xml, const std::function<void (juce::XmlElement&)>& visit)
{
    visit (xml);
    for (auto* child : xml.getChildIterator())
        forEachElement (*child, visit);
}
}

juce::StringArray listFiles (const juce::File& folder)
{
    juce::StringArray files;
    for (const auto& entry : juce::RangedDirectoryIterator (folder, true, "*", juce::File::findFiles))
        files.add (entry.getFile().getRelativePathFrom (folder).replaceCharacter ('\\', '/'));
    files.sort (true);
    return files;
}

juce::Result stage (const juce::File& projectFolder, const juce::File& session, juce::File& staged)
{
    auto xml = juce::parseXML (session);
    if (xml == nullptr)
        return juce::Result::fail ("Couldn't read the session.");

    const auto name = projectFolder.getFileNameWithoutExtension();
    const auto root = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("micfx-out").getNonexistentChildFile ("export", "");
    staged = root.getChildFile (name + ".micfx");
    if (! staged.createDirectory())
        return juce::Result::fail ("Couldn't make " + staged.getFullPathName() + ".");

    // The project's own files, but not its backups, versions and history.
    for (const auto& relative : listFiles (projectFolder))
    {
        if (relative == "project.xml" || leftBehind.contains (relative.upToFirstOccurrenceOf ("/", false, false)) || relative.startsWithChar ('.'))
            continue;
        const auto target = staged.getChildFile (relative);
        target.getParentDirectory().createDirectory();
        if (! projectFolder.getChildFile (relative).copyFileTo (target))
            return juce::Result::fail ("Couldn't copy " + relative + ".");
    }

    // Audio from elsewhere in the browser's storage comes along into Audio/.
    std::map<juce::String, juce::String> brought; // absolute path -> path in the project
    juce::String error;
    forEachElement (*xml, [&] (juce::XmlElement& element)
    {
        for (const auto& attribute : pathAttributes)
        {
            const auto path = element.getStringAttribute (attribute);
            if (path.isEmpty() || ! juce::File::isAbsolutePath (path))
                continue;

            const juce::File file (path);
            if (file.isAChildOf (projectFolder))
            {
                element.setAttribute (attribute, file.getRelativePathFrom (projectFolder).replaceCharacter ('\\', '/'));
                continue;
            }

            if (! brought.count (path))
            {
                if (! file.existsAsFile())
                    continue; // missing already: the desktop asks where it went
                const auto copy = freeChild (staged.getChildFile ("Audio"), file.getFileNameWithoutExtension(), file.getFileExtension());
                copy.getParentDirectory().createDirectory();
                if (! file.copyFileTo (copy))
                {
                    error = "Couldn't copy " + file.getFileName() + ".";
                    continue;
                }
                brought[path] = "Audio/" + copy.getFileName();
            }
            element.setAttribute (attribute, brought[path]);
        }
    });

    if (error.isNotEmpty())
        return juce::Result::fail (error);
    if (! xml->writeTo (staged.getChildFile ("project.xml")))
        return juce::Result::fail ("Couldn't write project.xml.");
    return juce::Result::ok();
}

juce::Result pack (const juce::File& staged, juce::File& bundle)
{
    bundle = staged.getSiblingFile (staged.getFileNameWithoutExtension() + bundleExtension);
    juce::ZipFile::Builder builder;
    const auto top = staged.getFileName();
    for (const auto& relative : listFiles (staged))
    {
        // Audio is compressed already (or barely shrinks): stored, so packing is quick.
        const auto isXml = relative.endsWithIgnoreCase (".xml");
        builder.addFile (staged.getChildFile (relative), isXml ? 6 : 0, top + "/" + relative);
    }

    bundle.deleteFile();
    juce::FileOutputStream out (bundle);
    if (! out.openedOk() || ! builder.writeToStream (out, nullptr))
        return juce::Result::fail ("Couldn't write " + bundle.getFileName() + ".");
    return juce::Result::ok();
}

juce::Result unpack (const juce::File& bundle, const juce::File& projectsFolder, juce::File& project)
{
    juce::ZipFile zip (bundle);
    if (zip.getNumEntries() == 0)
        return juce::Result::fail (bundle.getFileName() + " isn't a MicFX project file.");

    // Where project.xml is: the project's folder inside the zip (or the zip's top).
    juce::String prefix;
    bool found = false;
    for (int i = 0; i < zip.getNumEntries() && ! found; ++i)
    {
        const auto name = zip.getEntry (i)->filename.replaceCharacter ('\\', '/');
        if (name == "project.xml" || name.endsWith ("/project.xml"))
        {
            if (name.upToLastOccurrenceOf ("/", false, false).contains ("/"))
                continue; // deeper than one folder: not this one
            prefix = name.dropLastCharacters (juce::String ("project.xml").length());
            found = true;
        }
    }
    if (! found)
        return juce::Result::fail (bundle.getFileName() + " has no MicFX project in it.");

    auto name = prefix.isNotEmpty() ? prefix.dropLastCharacters (1) : bundle.getFileNameWithoutExtension();
    if (name.endsWithIgnoreCase (".micfx"))
        name = name.dropLastCharacters (6);
    name = juce::File::createLegalFileName (name.isNotEmpty() ? name : juce::String ("Project"));
    projectsFolder.createDirectory();
    project = freeChild (projectsFolder, name, ".micfx");
    if (! project.createDirectory())
        return juce::Result::fail ("Couldn't make " + project.getFullPathName() + ".");

    for (int i = 0; i < zip.getNumEntries(); ++i)
    {
        const auto* entry = zip.getEntry (i);
        const auto path = entry->filename.replaceCharacter ('\\', '/');
        if (! path.startsWith (prefix) || path.endsWithChar ('/') || path.contains (".."))
            continue;
        const auto relative = path.substring (prefix.length());
        if (leftBehind.contains (relative.upToFirstOccurrenceOf ("/", false, false)))
            continue;

        const auto target = project.getChildFile (relative);
        target.getParentDirectory().createDirectory();
        std::unique_ptr<juce::InputStream> in (zip.createStreamForEntry (i));
        juce::FileOutputStream out (target);
        if (in == nullptr || ! out.openedOk() || out.writeFromInputStream (*in, -1) < 0)
            return juce::Result::fail ("Couldn't unpack " + relative + ".");
    }
    return juce::Result::ok();
}
}

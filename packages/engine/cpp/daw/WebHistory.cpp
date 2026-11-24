#include "WebHistory.h"

namespace
{
juce::int64 now() { return juce::Time::currentTimeMillis(); }

int maxId (const juce::ValueTree& tree)
{
    auto result = (int) tree.getProperty (daw::ids::id, 0);
    for (const auto& child : tree)
        result = juce::jmax (result, maxId (child));
    return result;
}

// Children are matched by type and id, so an undo that adds back one track only adds that
// track, and the engine keeps the others (and their plug-ins) as they are.
juce::String keyOf (const juce::ValueTree& tree)
{
    return tree.getType().toString() + ":" + tree.getProperty (daw::ids::id, juce::var()).toString();
}

juce::int64 versionTime (const juce::File& file)
{
    return file.getFileNameWithoutExtension().fromFirstOccurrenceOf ("version-", false, false).getLargeIntValue();
}

juce::int64 backupTime (const juce::File& backup)
{
    return backup.getFileNameWithoutExtension().fromFirstOccurrenceOf ("autosave-", false, false).getLargeIntValue();
}

juce::File newestBackup (const juce::File& backupsFolder)
{
    juce::File newest;
    juce::int64 best = -1;
    for (const auto& file : backupsFolder.findChildFiles (juce::File::findFiles, false, "autosave-*.xml"))
        if (const auto time = backupTime (file); time > best)
            best = time, newest = file;
    return newest;
}

bool writeAtomically (const juce::File& file, const std::function<bool (juce::OutputStream&)>& write)
{
    const auto temp = file.getSiblingFile (file.getFileName() + ".tmp");
    temp.deleteFile();
    bool ok = false;
    {
        juce::FileOutputStream out (temp);
        ok = out.openedOk() && write (out);
        out.flush();
        ok = ok && out.getStatus().wasOk();
    }
    if (ok && temp.moveFileTo (file))
        return true;
    temp.deleteFile();
    return false;
}
}

//==============================================================================
// One step rebuilt from the saved history: the session before and after it. The first
// perform (adding it to the undo manager) and, for the steps that were undone, the first undo
// leave the session alone: it's already there.
class SnapshotAction : public juce::UndoableAction
{
public:
    SnapshotAction (daw::Edit& e, juce::ValueTree b, juce::ValueTree a, bool skipPerformOnce, bool skipUndoOnce)
        : edit (e), before (std::move (b)), after (std::move (a)), skipPerform (skipPerformOnce), skipUndo (skipUndoOnce) {}

    bool perform() override
    {
        if (std::exchange (skipPerform, false))
            return true;
        WebHistory::syncTree (edit.getState(), after, true);
        return true;
    }

    bool undo() override
    {
        if (std::exchange (skipUndo, false))
            return true;
        WebHistory::syncTree (edit.getState(), before, true);
        return true;
    }

    int getSizeInUnits() override { return 10; }

private:
    daw::Edit& edit;
    juce::ValueTree before, after;
    bool skipPerform, skipUndo;
};

//==============================================================================
WebHistory::WebHistory (daw::Edit& e, daw::Project& p, std::function<void (const juce::String&, const juce::var&)> emitEvent)
    : edit (e), project (p), undo (e.getUndoManager()), emit (std::move (emitEvent))
{
    undo.addChangeListener (this);
    edit.getState().addListener (this);

    // Autosave is ours (every few seconds, not every minute), and each save makes a version.
    project.setAutosaveInterval (0);
    previousBeforeWrite = project.onBeforeWrite;
    project.onBeforeWrite = [this]
    {
        if (previousBeforeWrite)
            previousBeforeWrite();
        if (! writingBackup)
            pendingSave = true;
    };
}

WebHistory::~WebHistory()
{
    project.onBeforeWrite = previousBeforeWrite;
    edit.getState().removeListener (this);
    undo.removeChangeListener (this);
}

void WebHistory::start()
{
    lastVersion = now();
    tick(); // picks up the open project
}

void WebHistory::touched()
{
    if (applying)
        return;

    const auto time = now();
    if (! changed)
        firstChange = time;
    changed = true;
    changedSinceVersion = true;
    lastChange = time;
}

// A project opened, made or saved under another name: the history follows it. True when
// the project changed.
bool WebHistory::followProject()
{
    if (project.getFolder() == folder)
        return false;

    {
        // Opening or making a project clears the undo history; Save as keeps it.
        const auto saveAs = folder != juce::File() && project.isOpen()
                         && undo.getUndoDescriptions().size() + undo.getRedoDescriptions().size() > 0;
        folder = project.getFolder();

        if (saveAs)
        {
            for (auto& step : steps)
                step.file = {}; // into the new folder
            historyDirty = true;
        }
        else if (project.isOpen())
        {
            // The newest autosave is the session the person left (a tab doesn't close cleanly,
            // so the desktop would offer it as a crash recovery).
            // (When it did close cleanly, the newest autosave still wins if it's newer.)
            auto backup = project.getRecoverableBackup();
            if (! backup.existsAsFile())
            {
                const auto newest = newestBackup (project.getBackupsFolder());
                const auto savedTime = project.getFolder().getChildFile ("project.xml").getLastModificationTime().toMilliseconds();
                if (newest.existsAsFile() && backupTime (newest) > savedTime)
                    backup = newest;
            }
            if (backup.existsAsFile())
            {
                const juce::ScopedValueSetter<bool> quiet (applying, true);
                project.restoreBackup (backup);
            }

            if (! loadHistory())
                resetHistory();
        }
        else
        {
            steps.clear();
            position = 0;
        }

        changed = changedSinceVersion = project.hasUnsavedChanges();
        pendingSave = false; // the new project's first write isn't a version
        firstChange = lastChange = now();
        writeHistory();
    }
    return true;
}

void WebHistory::tick()
{
    if (followProject() || ! project.isOpen())
        return;

    const auto time = now();
    if (changed && (time - lastChange >= 1000 || time - firstChange >= 5000))
        flush();

    // Every few minutes of work, a version to go back to.
    if (changedSinceVersion && time - lastVersion >= versionEveryMs && savedAt > lastVersion)
    {
        addVersion (newestBackup (project.getBackupsFolder()), false);
        changedSinceVersion = false;
    }

    // Saved (Ctrl+S): that's a version too (unless it's the same as the last saved one).
    if (std::exchange (pendingSave, false))
    {
        const auto saved = project.getFolder().getChildFile ("project.xml");
        juce::File lastSaved;
        for (const auto& version : findVersions())
            if (version.getFileNameWithoutExtension().endsWith ("-saved"))
            {
                lastSaved = version;
                break;
            }
        if (! lastSaved.existsAsFile() || lastSaved.loadFileAsString() != saved.loadFileAsString())
            addVersion (saved, true);
        changedSinceVersion = false;
    }
}

void WebHistory::changeListenerCallback (juce::ChangeBroadcaster*)
{
    followUndo();
}

void WebHistory::flush()
{
    followProject();
    if (! project.isOpen())
        return;

    followUndo();

    if (changed)
    {
        autosave();

        // The session now is the state at this point of the history (with what isn't undoable,
        // like arming a track, since the last step).
        if (! steps.empty())
        {
            steps[(size_t) position].state = edit.getState().createCopy();
            steps[(size_t) position].file = {};
            historyDirty = true;
        }
    }

    writeHistory();
}

void WebHistory::autosave()
{
    changed = false;

    if (! project.hasUnsavedChanges())
        return;

    const juce::ScopedValueSetter<bool> backup (writingBackup, true);
    if (project.writeBackup().isEmpty())
    {
        savedAt = now();
        auto* event = new juce::DynamicObject();
        event->setProperty ("time", savedAt);
        emit ("webSaved", juce::var (event));
    }
}

// Keeps `steps` in line with the undo manager: new steps get a snapshot of the session, undo
// and redo move the position.
void WebHistory::followUndo()
{
    if (applying || ! project.isOpen() || steps.empty())
        return;

    const auto names = undo.getUndoDescriptions(); // newest first
    const auto u = names.size();
    const auto r = undo.getRedoDescriptions().size();
    const auto known = (int) steps.size() - 1;

    // Only undo or redo since we last looked.
    if (r > 0 && u + r == known)
    {
        if (position != u)
            position = u, historyDirty = true;
        return;
    }

    if (u == 0 && r == 0)
    {
        if (known > 0)
            resetHistory(); // the history was cleared (a project opened)
        return;
    }

    // Several things happened at once (steps, undos, redos). The steps at the start that
    // are still the same stay; the ones after them up to now get the session as it is now
    // (in between ones are lost). Steps to redo that we never saw can't be rebuilt: they're
    // left out until they're redone.
    auto same = juce::jmin (known, u);
    if (r == 0 && known != u)
        same = juce::jmin (same, u - 1); // a new step came in at least at u
    for (int i = 1; i <= same; ++i)
        if (steps[(size_t) i].name != names[u - i])
        {
            same = i - 1;
            break;
        }

    if (same == u && known == u && position == u)
        return; // nothing new

    steps.resize ((size_t) same + 1);
    for (int k = same + 1; k <= u; ++k)
        steps.push_back ({ names[u - k], edit.getState().createCopy(), {} });
    position = u;
    historyDirty = true;

    while ((int) steps.size() - 1 > maxSteps)
    {
        steps.erase (steps.begin());
        --position;
        historyDirty = true;
    }
}

void WebHistory::resetHistory()
{
    steps.clear();
    steps.push_back ({ {}, edit.getState().createCopy(), {} });
    position = 0;
    historyDirty = true;
}

// The session as text, the same whether it was read from a saved project (where values come
// back as numbers from text) or kept in memory: numbers and booleans are written one way.
juce::String WebHistory::fingerprint (const juce::ValueTree& tree)
{
    juce::String out;
    const std::function<void (const juce::ValueTree&, bool)> write = [&] (const juce::ValueTree& node, bool top)
    {
        out << "<" << node.getType().toString();
        for (int i = 0; i < node.getNumProperties(); ++i)
        {
            const auto name = node.getPropertyName (i);
            if (top && (name == daw::ids::viewState || name == daw::ids::version))
                continue;
            const auto& value = node[name];
            auto text = value.isBool() ? juce::String ((bool) value ? "1" : "0") : value.toString();
            if (text == "true" || text == "false")
                text = text == "true" ? "1" : "0";
            else if (text.isNotEmpty() && text.containsOnly ("0123456789.-+eE") && text.containsAnyOf ("0123456789"))
                text = juce::String (text.getDoubleValue(), 6);
            out << " " << name.toString() << "=" << text.quoted();
        }
        out << ">";
        for (const auto& child : node)
            write (child, false);
        out << "</>";
    };
    write (tree, true);
    return out;
}

void WebHistory::syncTree (juce::ValueTree target, const juce::ValueTree& source, bool top)
{
    for (int i = target.getNumProperties(); --i >= 0;)
        if (const auto name = target.getPropertyName (i); ! source.hasProperty (name) && ! (top && name == daw::ids::viewState))
            target.removeProperty (name, nullptr);

    for (int i = 0; i < source.getNumProperties(); ++i)
        if (const auto name = source.getPropertyName (i); ! (top && name == daw::ids::viewState))
            target.setProperty (name, source[name], nullptr); // a no-op when it's the same

    for (int i = 0; i < source.getNumChildren(); ++i)
    {
        const auto wanted = source.getChild (i);
        const auto key = keyOf (wanted);

        int found = -1;
        for (int j = i; j < target.getNumChildren() && found < 0; ++j)
            if (keyOf (target.getChild (j)) == key)
                found = j;

        if (found < 0)
        {
            target.addChild (wanted.createCopy(), i, nullptr);
            continue;
        }

        if (found != i)
            target.moveChild (found, i, nullptr);
        syncTree (target.getChild (i), wanted, false);
    }

    while (target.getNumChildren() > source.getNumChildren())
        target.removeChild (target.getNumChildren() - 1, nullptr);
}

bool WebHistory::loadHistory()
{
    const auto dir = historyFolder();
    const auto json = juce::JSON::parse (dir.getChildFile ("history.json"));
    const auto* list = json["steps"].getArray();
    if (list == nullptr || ! json["base"].isString())
        return false;

    const auto read = [&dir, this] (const juce::String& name)
    {
        nextFile = juce::jmax (nextFile, name.retainCharacters ("0123456789").getIntValue() + 1);
        juce::FileInputStream in (dir.getChildFile (name));
        return in.openedOk() ? juce::ValueTree::readFromStream (in) : juce::ValueTree();
    };

    std::vector<Step> loaded;
    loaded.push_back ({ {}, read (json["base"].toString()), json["base"].toString() });
    for (const auto& step : *list)
        loaded.push_back ({ step["name"].toString(), read (step["file"].toString()), step["file"].toString() });

    const auto at = (int) json["position"];
    if (at < 0 || at >= (int) loaded.size())
        return false;
    for (const auto& step : loaded)
        if (! step.state.hasType (daw::ids::PROJECT))
            return false;

    // Only when the project is where the history left it (not changed elsewhere since).
    if (fingerprint (edit.getState()) != fingerprint (loaded[(size_t) at].state))
        return false;

    const juce::ScopedValueSetter<bool> quiet (applying, true);

    // Ids are never reused: steps that were undone may hold ids above the session's.
    int highest = 0;
    for (const auto& step : loaded)
        highest = juce::jmax (highest, maxId (step.state));
    if (highest > maxId (edit.getState()))
    {
        auto withId = edit.getState().createCopy();
        juce::ValueTree marker ("WEB_ID");
        marker.setProperty (daw::ids::id, highest, nullptr);
        withId.appendChild (marker, nullptr);
        edit.replaceState (withId); // sets the next id past it
        edit.getState().removeChild (edit.getState().getChildWithName ("WEB_ID"), nullptr);
    }

    undo.clearUndoHistory();
    const auto count = (int) loaded.size() - 1;
    for (int i = 1; i <= count; ++i)
    {
        undo.beginNewTransaction (loaded[(size_t) i].name);
        undo.perform (new SnapshotAction (edit, loaded[(size_t) i - 1].state, loaded[(size_t) i].state, true, i > at));
    }
    for (int i = at; i < count; ++i)
        undo.undo();
    undo.beginNewTransaction();

    steps = std::move (loaded);
    position = at;
    historyDirty = false;
    return true;
}

void WebHistory::writeHistory()
{
    if (! historyDirty || ! project.isOpen() || steps.empty())
        return;

    const auto dir = historyFolder();
    dir.createDirectory();

    for (auto& step : steps)
    {
        if (step.file.isNotEmpty())
            continue;
        const auto name = "state-" + juce::String (nextFile++) + ".bin";
        if (! writeAtomically (dir.getChildFile (name), [&step] (juce::OutputStream& out) { step.state.writeToStream (out); return true; }))
            return; // try again with the next change
        step.file = name;
    }

    auto* json = new juce::DynamicObject();
    json->setProperty ("base", steps.front().file);
    json->setProperty ("position", position);
    juce::Array<juce::var> list;
    for (size_t i = 1; i < steps.size(); ++i)
    {
        auto* step = new juce::DynamicObject();
        step->setProperty ("name", steps[i].name);
        step->setProperty ("file", steps[i].file);
        list.add (juce::var (step));
    }
    json->setProperty ("steps", list);
    const auto text = juce::JSON::toString (juce::var (json));

    if (! writeAtomically (dir.getChildFile ("history.json"), [&text] (juce::OutputStream& out) { return out.writeText (text, false, false, nullptr); }))
        return;

    // Snapshots no step uses any more.
    juce::StringArray used;
    for (const auto& step : steps)
        used.add (step.file);
    for (const auto& file : dir.findChildFiles (juce::File::findFiles, false, "state-*.bin"))
        if (! used.contains (file.getFileName()))
            file.deleteFile();

    historyDirty = false;
}

//==============================================================================
juce::Array<juce::File> WebHistory::findVersions() const
{
    auto files = versionsFolder().findChildFiles (juce::File::findFiles, false, "version-*.xml");
    std::sort (files.begin(), files.end(), [] (const auto& a, const auto& b) { return versionTime (a) > versionTime (b); });
    return files;
}

void WebHistory::addVersion (const juce::File& from, bool saved)
{
    if (! from.existsAsFile())
        return;

    auto time = now();
    if (const auto existing = findVersions(); ! existing.isEmpty())
        time = juce::jmax (time, versionTime (existing.getFirst()) + 1);

    versionsFolder().createDirectory();
    from.copyFileTo (versionsFolder().getChildFile ("version-" + juce::String (time) + (saved ? "-saved" : "-auto") + ".xml"));
    lastVersion = now();

    auto versions = findVersions();
    for (int i = maxVersions; i < versions.size(); ++i)
        versions.getReference (i).deleteFile();
}

juce::File WebHistory::currentSessionFile()
{
    flush();
    if (! project.hasUnsavedChanges())
        return project.getFolder().getChildFile ("project.xml");

    const juce::ScopedValueSetter<bool> backup (writingBackup, true);
    project.writeBackup();
    return newestBackup (project.getBackupsFolder());
}

juce::var WebHistory::describe() const
{
    auto* result = new juce::DynamicObject();
    result->setProperty ("savedAt", savedAt);
    result->setProperty ("path", project.getFolder().getFullPathName());
    result->setProperty ("unsaved", project.hasUnsavedChanges());
    juce::Array<juce::var> list;
    for (const auto& file : findVersions())
    {
        auto* version = new juce::DynamicObject();
        version->setProperty ("id", file.getFileName());
        version->setProperty ("time", versionTime (file));
        version->setProperty ("saved", file.getFileNameWithoutExtension().endsWith ("-saved"));
        list.add (juce::var (version));
    }
    result->setProperty ("versions", list);
    return juce::var (result);
}

juce::String WebHistory::restoreVersion (const juce::String& id)
{
    if (! project.isOpen())
        return "No project is open.";

    const auto file = versionsFolder().getChildFile (id);
    if (! id.startsWith ("version-") || id.containsAnyOf ("/\\") || ! file.existsAsFile())
        return "That version is gone.";

    // The session now becomes a version first, so going back can be undone the same way.
    if (project.hasUnsavedChanges())
    {
        changed = true;
        flush();
        addVersion (newestBackup (project.getBackupsFolder()), false);
    }

    const auto error = project.restoreBackup (file);
    changedSinceVersion = false;
    return error;
}

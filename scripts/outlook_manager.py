"""
Outlook Mail Management Module (Reusable).

Connects directly to the currently open Microsoft Outlook desktop application
via Windows COM (win32com) without requiring any authentication, API keys, or tokens.
"""

import win32com.client
from pathlib import Path


class OutlookManager:
    """
    Manager class to interface with a running Outlook desktop application.
    """

    def __init__(self):
        self.outlook = None
        self.namespace = None
        self._connect()

    def _connect(self):
        """
        Connects to the active or open Outlook application instance.
        """
        try:
            # Try connecting to already running instance first
            self.outlook = win32com.client.GetActiveObject("Outlook.Application")
            print("[+] Connected to active Outlook instance.")
        except Exception:
            try:
                self.outlook = win32com.client.Dispatch("Outlook.Application")
                print("[+] Dispatched Outlook Application object.")
            except Exception as e:
                raise RuntimeError(
                    f"Could not connect to Outlook. Please ensure Outlook is running. Error: {e}"
                )

        self.namespace = self.outlook.GetNamespace("MAPI")

    def get_folder_by_path(self, folder_path):
        """
        Traverses Outlook folder hierarchy to find a target folder.
        
        Args:
            folder_path (str or list): e.g. "My Folders/validation" or ["My Folders", "validation"]
            
        Returns:
            Folder object or None
        """
        if isinstance(folder_path, str):
            path_parts = [p.strip() for p in folder_path.replace("\\", "/").split("/") if p.strip()]
        else:
            path_parts = list(folder_path)

        if not path_parts:
            return None

        # Search across all root stores / accounts
        for store in self.namespace.Folders:
            current_folder = store
            matched = True
            for part in path_parts:
                found_child = None
                for child in current_folder.Folders:
                    if child.Name.lower() == part.lower():
                        found_child = child
                        break
                if found_child:
                    current_folder = found_child
                else:
                    matched = False
                    break
            if matched:
                return current_folder

        # If not found directly under store, perform a recursive search for the leaf folder name
        target_name = path_parts[-1].lower()
        parent_name = path_parts[-2].lower() if len(path_parts) >= 2 else None

        return self._search_folder_recursive(self.namespace.Folders, target_name, parent_name)

    def _search_folder_recursive(self, folders, target_name, parent_name=None):
        for folder in folders:
            if folder.Name.lower() == target_name:
                if parent_name is None:
                    return folder
                try:
                    if folder.Parent and folder.Parent.Name.lower() == parent_name:
                        return folder
                except Exception:
                    return folder
            # Recurse children
            try:
                sub_result = self._search_folder_recursive(folder.Folders, target_name, parent_name)
                if sub_result:
                    return sub_result
            except Exception:
                continue
        return None

    def get_latest_email(self, folder_path="My Folders/validation"):
        """
        Retrieves the single latest email from the specified folder path.
        
        Returns:
            MailItem object or None
        """
        folder = self.get_folder_by_path(folder_path)
        if not folder:
            raise FileNotFoundError(f"Folder '{folder_path}' was not found in Outlook.")

        items = folder.Items
        # Restrict only to mail items (IPM.Note) if needed, and sort descending by ReceivedTime
        items.Sort("[ReceivedTime]", True)

        if items.Count == 0:
            print(f"[-] No messages found in '{folder_path}'.")
            return None

        latest_item = items.GetFirst()
        return latest_item

    def get_emails(self, folder_path, count=10):
        """
        Retrieves the top N emails from a folder, sorted by ReceivedTime descending.
        """
        folder = self.get_folder_by_path(folder_path)
        if not folder:
            raise FileNotFoundError(f"Folder '{folder_path}' was not found in Outlook.")

        items = folder.Items
        items.Sort("[ReceivedTime]", True)

        results = []
        msg = items.GetFirst()
        while msg and len(results) < count:
            results.append(msg)
            msg = items.GetNext()

        return results

    def get_unread_emails(self, folder_path, count=None):
        """Return unread mail items from a folder, newest first.

        Args:
            folder_path: Folder path accepted by ``get_folder_by_path``.
            count: Optional maximum number of messages to return.
        """
        folder = self.get_folder_by_path(folder_path)
        if not folder:
            raise FileNotFoundError(f"Folder '{folder_path}' was not found in Outlook.")

        items = folder.Items.Restrict("[UnRead] = True")
        items.Sort("[ReceivedTime]", True)

        # Snapshot the COM collection before callers change messages' read state.
        messages = []
        message = items.GetFirst()
        while message and (count is None or len(messages) < count):
            if getattr(message, "Class", None) == 43:
                messages.append(message)
            message = items.GetNext()
        return messages

    def save_email_as_html(self, email, output_path):
        """Save an Outlook mail item as an HTML file and return its path."""
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        email.SaveAs(str(output_path), 5)  # Outlook olHTML format
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise IOError(f"Outlook did not create an HTML file: {output_path}")
        return output_path

    def mark_email_read(self, email):
        """Mark an Outlook mail item as read and save the change."""
        email.UnRead = False
        email.Save()


# Standalone quick test
if __name__ == "__main__":
    mgr = OutlookManager()
    folder_path = "My Folders/validation"
    print(f"[*] Looking for latest email in: {folder_path}...")
    email = mgr.get_latest_email(folder_path)
    if email:
        print(f"[+] Subject: {email.Subject}")
        print(f"[+] Received: {email.ReceivedTime}")
        print(f"[+] Sender: {email.SenderName} <{email.SenderEmailAddress}>")
    else:
        print("[-] No email found.")

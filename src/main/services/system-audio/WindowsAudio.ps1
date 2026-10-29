param(
    [ValidateSet('Get', 'Set')][string]$Action = 'Get',
    [ValidateRange(0, 1)][double]$Volume = 0,
    [ValidateSet('true', 'false')][string]$Muted = 'false',
    [string]$DeviceId = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Microsoft Core Audio endpoint APIs; Get never changes the output settings.
# The interface declarations preserve the native COM vtable order.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace AdhanDeskAudio {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class DeviceEnumerator { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
        [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
        [PreserveSig] int GetId(out IntPtr id);
        [PreserveSig] int GetState(out uint state);
    }
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr callback);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr callback);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid context);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
        [PreserveSig] int GetMasterVolumeLevel(out float level);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
        [PreserveSig] int GetVolumeStepInfo(out uint step, out uint count);
        [PreserveSig] int VolumeStepUp(ref Guid context);
        [PreserveSig] int VolumeStepDown(ref Guid context);
        [PreserveSig] int QueryHardwareSupport(out uint mask);
        [PreserveSig] int GetVolumeRange(out float minimum, out float maximum, out float increment);
    }
    public class Snapshot {
        public double Volume;
        public bool Muted;
        public string DeviceId;
    }
    public static class Endpoint {
        static void Check(int result) { Marshal.ThrowExceptionForHR(result); }
        public static Snapshot Execute(bool change, float volume, bool muted, string requestedId) {
            IMMDeviceEnumerator enumerator = null;
            IMMDevice device = null;
            object activated = null;
            IntPtr idPointer = IntPtr.Zero;
            try {
                enumerator = (IMMDeviceEnumerator)new DeviceEnumerator();
                if (String.IsNullOrEmpty(requestedId)) Check(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
                else Check(enumerator.GetDevice(requestedId, out device));
                Check(device.GetId(out idPointer));
                string id = Marshal.PtrToStringUni(idPointer);
                Guid iid = typeof(IAudioEndpointVolume).GUID;
                Check(device.Activate(ref iid, 23, IntPtr.Zero, out activated));
                IAudioEndpointVolume endpoint = (IAudioEndpointVolume)activated;
                float beforeVolume; bool beforeMuted;
                Check(endpoint.GetMasterVolumeLevelScalar(out beforeVolume));
                Check(endpoint.GetMute(out beforeMuted));
                Guid context = Guid.Empty;
                if (change) {
                    try {
                        if (muted) Check(endpoint.SetMute(true, ref context));
                        Check(endpoint.SetMasterVolumeLevelScalar(volume, ref context));
                        Check(endpoint.SetMute(muted, ref context));
                    } catch {
                        try {
                            if (beforeMuted) endpoint.SetMute(true, ref context);
                            endpoint.SetMasterVolumeLevelScalar(beforeVolume, ref context);
                            endpoint.SetMute(beforeMuted, ref context);
                        } catch { }
                        throw;
                    }
                }
                float currentVolume; bool currentMuted;
                Check(endpoint.GetMasterVolumeLevelScalar(out currentVolume));
                Check(endpoint.GetMute(out currentMuted));
                return new Snapshot { Volume = currentVolume, Muted = currentMuted, DeviceId = id };
            } finally {
                if (idPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(idPointer);
                if (activated != null && Marshal.IsComObject(activated)) Marshal.ReleaseComObject(activated);
                if (device != null && Marshal.IsComObject(device)) Marshal.ReleaseComObject(device);
                if (enumerator != null && Marshal.IsComObject(enumerator)) Marshal.ReleaseComObject(enumerator);
            }
        }
    }
}
'@

$snapshot = [AdhanDeskAudio.Endpoint]::Execute($Action -eq 'Set', [single]$Volume, $Muted -eq 'true', $DeviceId)
[pscustomobject]@{ volume = $snapshot.Volume; muted = $snapshot.Muted; deviceId = $snapshot.DeviceId } | ConvertTo-Json -Compress
